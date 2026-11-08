/**
 * Gerencia o processo do Chrome usado para o scraping.
 *
 * Por que Chrome de verdade em vez do Chromium do Playwright: o site fica atrás
 * do Cloudflare com "managed challenge". Chromium bundled, `chromium.launch()` e
 * `--headless=new` ficam presos no "Um momento..." para sempre. O que passa é um
 * Chrome lançado como processo normal do sistema (sem flags de automação) ao qual
 * nos conectamos depois via CDP — e ele precisa rodar em modo headed.
 *
 * Como o Chrome fica fora do caminho do usuário (ver também `esconderJanela`):
 *
 * - no macOS ele sobe via `open -g`, que NÃO rouba o foco do app em uso;
 * - logo depois de conectar, a janela é minimizada por CDP.
 *
 * `--window-position` com valores negativos grandes não resolve: o macOS gruda a
 * janela de volta na tela (testado — vira `left: 0`, totalmente visível), e mesmo
 * via CDP ele limita a uns 40px aparecendo. Minimizar é o único jeito de sumir.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

/** Perfil dedicado: mantém o cookie cf_clearance entre execuções, deixando as
 *  buscas seguintes bem mais rápidas. Nunca usa o perfil pessoal do usuário. */
const PROFILE_DIR = path.join(process.cwd(), '.chrome-profile');
/** Guarda a porta de debug para reaproveitar um Chrome que já esteja no ar. */
const PORT_FILE = path.join(PROFILE_DIR, '.cdp-port');

const CHROME_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  // a janela fica minimizada; sem isso o Chrome estrangula timers e rede nela
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

let endpoint: string | null = null;
/** Promessa da subida em curso, compartilhada por chamadas concorrentes. */
let emAndamento: Promise<string> | null = null;

async function cdpAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * O Chrome deixa SingletonLock/Socket/Cookie no perfil. Se o processo morreu sem
 * limpar (kill, crash), o próximo boot desiste em silêncio e nunca abre a porta
 * de debug.
 */
function limparLockOrfao(): void {
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    rmSync(path.join(PROFILE_DIR, f), { force: true });
  }
}

/**
 * Mata qualquer Chrome que ainda esteja usando o NOSSO perfil — nunca o Chrome
 * pessoal do usuário, porque o filtro é o caminho do perfil.
 *
 * Necessário porque o Chrome deixa renderers vivos depois de um kill no processo
 * pai. Se sobrar um deles, o próximo boot detecta o perfil ocupado, delega para a
 * instância existente e sai sem abrir a porta de debug.
 */
function matarChromeDoPerfil(): void {
  try {
    spawnSync(process.platform === 'win32' ? 'taskkill' : 'pkill',
      process.platform === 'win32' ? ['/F', '/FI', `COMMANDLINE eq *${PROFILE_DIR}*`] : ['-f', PROFILE_DIR],
      { stdio: 'ignore' });
  } catch {
    /* sem pkill disponível: seguimos e deixamos o waitForCdp reclamar */
  }
}

function findChrome(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const found = CHROME_PATHS.find(existsSync);
  if (!found) {
    throw new Error(
      'Google Chrome não encontrado. Instale o Chrome ou defina CHROME_PATH com o caminho do executável.',
    );
  }
  return found;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForCdp(port: number, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpAlive(port)) return `http://127.0.0.1:${port}`;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome não respondeu na porta de debug ${port}.`);
}

function lancar(bin: string, port: number): void {
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${PROFILE_DIR}`, ...CHROME_FLAGS, 'about:blank'];

  // macOS: `open -g` sobe o app em background, sem tirar o foco de onde o
  // usuário está. `-n` força uma instância nova, isolada do Chrome pessoal.
  const appBundle = bin.match(/^(.*\.app)\/Contents\/MacOS\//)?.[1];
  if (process.platform === 'darwin' && appBundle) {
    const r = spawnSync('open', ['-g', '-n', '-a', appBundle, '--args', ...args], { stdio: 'ignore' });
    if (r.status === 0) return;
    // se o `open` falhar, cai para o spawn direto (só custa o foco)
  }

  const proc = spawn(bin, args, { stdio: 'ignore', detached: true });
  proc.unref();
}

/**
 * Sobe o Chrome (se ainda não estiver rodando) e devolve o endpoint CDP.
 *
 * Chamadas concorrentes compartilham a mesma promessa. Sem isso, duas buscas
 * iniciadas junto entrariam aqui ao mesmo tempo e a segunda mataria — via
 * `matarChromeDoPerfil` — justamente o Chrome que a primeira acabou de subir.
 */
export function ensureChrome(): Promise<string> {
  if (!emAndamento) {
    emAndamento = garantirChrome().finally(() => {
      emAndamento = null;
    });
  }
  return emAndamento;
}

async function garantirChrome(): Promise<string> {
  if (endpoint) {
    const porta = Number(new URL(endpoint).port);
    if (await cdpAlive(porta)) return endpoint;
    endpoint = null;
  }

  // Já existe um Chrome nosso no ar (ex.: servidor reiniciado)? Reaproveita —
  // isso preserva o cookie do Cloudflare e evita brigar pelo lock do perfil.
  if (existsSync(PORT_FILE)) {
    const porta = Number(readFileSync(PORT_FILE, 'utf8').trim());
    if (porta && (await cdpAlive(porta))) {
      endpoint = `http://127.0.0.1:${porta}`;
      return endpoint;
    }
  }

  const bin = findChrome();
  const port = await freePort();
  mkdirSync(PROFILE_DIR, { recursive: true });
  matarChromeDoPerfil();
  limparLockOrfao();

  lancar(bin, port);
  endpoint = await waitForCdp(port);
  writeFileSync(PORT_FILE, String(port));
  return endpoint;
}

export function closeChrome(): void {
  matarChromeDoPerfil();
  rmSync(PORT_FILE, { force: true });
  endpoint = null;
}

for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    closeChrome();
    if (sig !== 'exit') process.exit(0);
  });
}
