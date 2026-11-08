/**
 * Extração das lojas + telefones de uma página de produto da LigaPokemon.
 *
 * Como funciona (descoberto por engenharia reversa da página):
 *
 * 1. A página do produto carrega TODAS as ofertas de uma vez num objeto global
 *    JS — `screenfilter.obj` (uma entrada por oferta, com `lj_id`) e
 *    `screenfilter.stores` (mapa id -> dados da loja, incluindo `lj_name`).
 *    Não existe paginação de verdade: os "16 de 94" são renderização preguiçosa
 *    no cliente. Um único page load já entrega todas as lojas.
 *
 * 2. O telefone não está na página do produto. Ele vem do endpoint AJAX
 *    `/ajax/mp/actions.php?opc=getStoreData&id=<lojaId>&tcg=2`, que devolve
 *    JSON com um campo `html`. Dentro desse HTML o número aparece de duas
 *    formas; preferimos o link do WhatsApp (`phone=5549999666442`) porque é
 *    E.164 limpo — o texto formatado do próprio site vem com máscara bugada
 *    ("(49) 9996-66442" em vez de "(49) 99966-6442").
 *
 * As chamadas AJAX rodam DENTRO da página, via fetch, para herdar cookies e
 * sessão do Cloudflare automaticamente.
 *
 * Ritmo: medido empiricamente. Sequencial com ~1s de pausa dá 0 falhas em 30
 * lojas; 4 em paralelo faz o Cloudflare passar a devolver página de challenge
 * em vez de JSON a partir da ~10ª requisição.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { ensureChrome } from './chrome.js';

export interface Loja {
  nome: string;
  telefone: string;
  /** true quando o Cloudflare bloqueou a consulta até o fim das tentativas. */
  falhou?: boolean;
}

export interface Resultado {
  produto: string;
  url: string;
  lojas: Loja[];
  semTelefone: number;
  falhas: number;
}

export type Progresso = (etapa: string, atual?: number, total?: number) => void;

/** Pausa entre consultas, em ms. Não abaixe: é o que mantém o Cloudflare quieto. */
const DELAY = 1000;
/** Tentativas por loja quando o Cloudflare interrompe. */
const MAX_RETRY = 3;

export function validarUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('URL inválida. Cole o link completo do produto.');
  }
  if (!/(^|\.)ligapokemon\.com\.br$/i.test(u.hostname)) {
    throw new Error('O link precisa ser do site ligapokemon.com.br.');
  }
  return u.toString();
}

/** Normaliza um número brasileiro para exibição: (DD) NNNNN-NNNN. */
export function formatarTelefone(digitos: string): string {
  let d = digitos.replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

const ESPERANDO_LOJAS =
  "typeof screenfilter !== 'undefined' && screenfilter.obj && screenfilter.obj.length > 0";

async function esperarLojas(page: Page, timeout = 90_000): Promise<void> {
  await page.waitForFunction(ESPERANDO_LOJAS, null, { timeout });
}

/**
 * Controla a janela do Chrome por CDP.
 *
 * Tem que ser por CDP porque o macOS ignora `--window-position` com valores
 * negativos grandes — a janela volta grudada na tela (vira `left: 0`). Mesmo por
 * CDP ele só deixa arrastar até sobrar uns 40px à mostra, então minimizar é a
 * única forma de sumir de verdade.
 */
async function controlarJanela(ctx: BrowserContext, page: Page) {
  let cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>> | null = null;
  let windowId: number | null = null;
  try {
    cdp = await ctx.newCDPSession(page);
    ({ windowId } = (await cdp.send('Browser.getWindowForTarget' as never)) as {
      windowId: number;
    });
  } catch {
    /* sem CDP de janelas (outro SO): os métodos abaixo viram no-op */
  }

  const estado = async (windowState: 'minimized' | 'normal') => {
    if (!cdp || windowId == null) return;
    try {
      await cdp.send('Browser.setWindowBounds' as never, { windowId, bounds: { windowState } } as never);
    } catch {
      /* cosmético: se falhar, a busca continua */
    }
  };

  return {
    minimizar: () => estado('minimized'),
    restaurar: () => estado('normal'),
  };
}

/** Quanto esperar pelo Cloudflare com a janela escondida antes de mostrá-la. */
const ESPERA_MINIMIZADA = 20_000;
const ESPERA_VISIVEL = 70_000;

async function abrirProduto(browser: Browser, url: string, progresso: Progresso): Promise<Page> {
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();
  const janela = await controlarJanela(ctx, page);

  // Some com a janela antes de qualquer coisa aparecer nela.
  await janela.minimizar();

  progresso('Abrindo a página do produto…');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  progresso('Aguardando liberação do Cloudflare…');
  try {
    await esperarLojas(page, ESPERA_MINIMIZADA);
  } catch {
    // Minimizado o Chrome resolve o desafio do Cloudflare devagar e de forma
    // imprevisível (medido: 16s, 53s, às vezes nem em 90s). Como último recurso
    // mostramos a janela, que destrava na hora, e escondemos de novo em seguida.
    // Na prática só acontece na primeira busca: depois o cookie fica no perfil.
    progresso('Liberação demorando — abrindo o Chrome por alguns segundos…');
    await janela.restaurar();
    try {
      await esperarLojas(page, ESPERA_VISIVEL);
    } catch {
      const titulo = await page.title().catch(() => '');
      await page.close();
      if (/moment|momento/i.test(titulo)) {
        throw new Error(
          'O Cloudflare não liberou o acesso. Tente novamente em alguns minutos — ' +
            'a primeira busca costuma ser a mais demorada.',
        );
      }
      throw new Error(
        'Não encontrei a lista de lojas nessa página. Confirme que o link é de um produto ' +
          'com lojas vendendo (ex.: ?view=prod/view&pcode=135107).',
      );
    }
  }

  await janela.minimizar();
  return page;
}

type Consulta = { ok: true; numeros: string[] } | { ok: false; challenge: boolean };

/** Consulta o contato de uma loja de dentro da página. */
async function consultarLoja(page: Page, id: string): Promise<Consulta> {
  return page.evaluate(async (lojaId: string): Promise<Consulta> => {
    try {
      const res = await fetch(
        `/ajax/mp/actions.php?opc=getStoreData&id=${lojaId}&origin=desktop&tcg=2`,
      );
      const raw = await res.text();
      // Sob rate limit o Cloudflare devolve uma página HTML de challenge no
      // lugar do JSON — é assim que detectamos que precisamos desacelerar.
      if (!raw.trimStart().startsWith('{')) return { ok: false, challenge: true };

      const html = String(JSON.parse(raw)?.html ?? '');
      const wa = [...new Set([...html.matchAll(/phone=(\d{10,15})/g)].map((m) => m[1]))];
      if (wa.length) return { ok: true, numeros: wa };

      // Sem link de WhatsApp: cai para o telefone escrito no HTML. A máscara do
      // site é bugada, mas os dígitos estão certos.
      const txt = [
        ...new Set(
          [...html.matchAll(/\((\d{2})\)\s*([\d\s-]{8,12})/g)].map(
            (m) => m[1] + m[2].replace(/\D/g, ''),
          ),
        ),
      ].filter((d) => d.length === 10 || d.length === 11);
      return { ok: true, numeros: txt };
    } catch {
      return { ok: false, challenge: false };
    }
  }, id);
}

export async function scrapeProduto(
  urlRaw: string,
  progresso: Progresso = () => {},
): Promise<Resultado> {
  const url = validarUrl(urlRaw);
  const endpoint = await ensureChrome();

  let browser: Browser | null = null;
  let page: Page | null = null;
  try {
    browser = await chromium.connectOverCDP(endpoint);
    page = await abrirProduto(browser, url, progresso);

    const { produto, lojas: lista } = await page.evaluate(() => {
      const sf = (globalThis as any).screenfilter;
      const ids = [...new Set(sf.obj.map((o: any) => String(o.lj_id)))] as string[];
      const nomeProduto =
        document.querySelector('h1')?.textContent?.trim() || document.title.split('|')[0].trim();
      return {
        produto: nomeProduto,
        lojas: ids.map((id) => ({
          id,
          nome: String(sf.stores?.[id]?.lj_name ?? `Loja ${id}`).trim(),
        })),
      };
    });

    const total = lista.length;
    progresso(`${total} lojas encontradas. Buscando telefones…`, 0, total);

    const resultado: Loja[] = [];
    for (let i = 0; i < total; i++) {
      const { id, nome } = lista[i];
      let numeros: string[] = [];
      let falhou = true;

      for (let tentativa = 0; tentativa <= MAX_RETRY; tentativa++) {
        const r = await consultarLoja(page, id);
        if (r.ok) {
          numeros = r.numeros;
          falhou = false;
          break;
        }
        if (tentativa === MAX_RETRY) break;

        // Backoff e, no caso de challenge, reabre a página para renovar a sessão.
        const espera = 3_000 * (tentativa + 1);
        progresso(
          `Cloudflare interrompeu. Aguardando ${espera / 1000}s e tentando de novo… (${i + 1}/${total})`,
          i,
          total,
        );
        await page.waitForTimeout(espera);
        if (r.challenge) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
          await esperarLojas(page).catch(() => {});
        }
      }

      resultado.push({
        nome,
        telefone: numeros.map(formatarTelefone).filter(Boolean).join(' / '),
        ...(falhou ? { falhou: true } : {}),
      });

      progresso(`Buscando telefones… ${i + 1}/${total}`, i + 1, total);
      if (i < total - 1) await page.waitForTimeout(DELAY);
    }

    resultado.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    return {
      produto,
      url,
      lojas: resultado,
      semTelefone: resultado.filter((l) => !l.telefone && !l.falhou).length,
      falhas: resultado.filter((l) => l.falhou).length,
    };
  } finally {
    await page?.close().catch(() => {});
    // Fecha só a conexão CDP — o processo do Chrome fica vivo para reuso.
    await browser?.close().catch(() => {});
  }
}
