const express = require('express');
const fs      = require('fs');
const path    = require('path');
const Database = require('better-sqlite3');

const app   = express();
const PORT  = process.env.PORT || 3000;

// ── Diretórios — usa variável de ambiente no Railway, local em dev ────────────
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR   = path.join(DATA_DIR, 'uploads');
const DB_FILE       = path.join(DATA_DIR, 'shadows.db');
const ESTADO_LEGADO = path.join(DATA_DIR, 'estado.json');
const PRODUTOS_FILE = path.join(DATA_DIR, 'produtos.json');
const BACKUP_DIR    = path.join(DATA_DIR, 'backups');

app.use(express.json({ limit: '5mb' })); // limite global seguro; /api/estado e /api/gerar-pdf têm limites próprios

if (!fs.existsSync(DATA_DIR))    fs.mkdirSync(DATA_DIR,    { recursive: true });
if (!fs.existsSync(BACKUP_DIR))  fs.mkdirSync(BACKUP_DIR,  { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Banco de dados ────────────────────────────────────────────────────────────
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS cadastros (
    id            INTEGER PRIMARY KEY,
    dados         TEXT    NOT NULL,
    criado_em     TEXT,
    atualizado_em TEXT
  );
  CREATE TABLE IF NOT EXISTS fretes (
    id            INTEGER PRIMARY KEY,
    dados         TEXT    NOT NULL,
    log_ts        INTEGER DEFAULT 0,
    atualizado_em TEXT
  );
  CREATE TABLE IF NOT EXISTS aplicacoes_logo (
    id            INTEGER PRIMARY KEY,
    dados         TEXT    NOT NULL,
    log_ts        INTEGER DEFAULT 0,
    atualizado_em TEXT
  );
  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
`);

// ── Helpers ───────────────────────────────────────────────────────────────────
function maxLogTs(item) {
  if (!item || !Array.isArray(item.log) || !item.log.length) return 0;
  return Math.max(...item.log.map(e => e.em ? new Date(e.em).getTime() : 0));
}

// ── Migração do estado.json legado ─────────────────────────────────────────────
function migrarSeVazio() {
  const temDados = db.prepare('SELECT COUNT(*) AS n FROM cadastros').get().n > 0
    || db.prepare('SELECT COUNT(*) AS n FROM fretes').get().n > 0
    || db.prepare('SELECT COUNT(*) AS n FROM aplicacoes_logo').get().n > 0;
  if (temDados) return;
  if (!fs.existsSync(ESTADO_LEGADO)) { console.log('Banco vazio — pronto para uso.'); return; }
  try {
    const d = JSON.parse(fs.readFileSync(ESTADO_LEGADO, 'utf-8'));
    const now = new Date().toISOString();
    const migrar = db.transaction(() => {
      const iCad  = db.prepare('INSERT OR IGNORE INTO cadastros (id, dados, criado_em, atualizado_em) VALUES (?,?,?,?)');
      const iFrt  = db.prepare('INSERT OR IGNORE INTO fretes (id, dados, log_ts, atualizado_em) VALUES (?,?,?,?)');
      const iLogo = db.prepare('INSERT OR IGNORE INTO aplicacoes_logo (id, dados, log_ts, atualizado_em) VALUES (?,?,?,?)');
      const iCfg  = db.prepare('INSERT OR IGNORE INTO config (chave, valor) VALUES (?,?)');
      (d.cadastros      || []).forEach(c => iCad.run( c.id, JSON.stringify(c), c.criado_em || now, now));
      (d.fretes         || []).forEach(f => iFrt.run( f.id, JSON.stringify(f), maxLogTs(f),       now));
      (d.aplicacoesLogo || []).forEach(a => iLogo.run(a.id, JSON.stringify(a), maxLogTs(a),       now));
      ['nextId','nextLogoId','nextFreteId',
       'VENDEDORAS','TRANSPORTADORAS','FORMAS_PAGAMENTO','tabelaPrecos',
       'shadows_logo_menu','shadows_logo_login','shadows_logo_pdf'
      ].forEach(k => { if (d[k] !== undefined) iCfg.run(k, JSON.stringify(d[k])); });
    });
    migrar();
    console.log('Migrado de estado.json: '
      + (d.cadastros||[]).length + ' cadastros, '
      + (d.fretes||[]).length + ' fretes, '
      + (d.aplicacoesLogo||[]).length + ' logos.');
  } catch(err) {
    console.error('Erro na migracao:', err.message);
  }
}
migrarSeVazio();

// ── Modelagem ─────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS modelagens (
    id            INTEGER PRIMARY KEY,
    dados         TEXT    NOT NULL,
    log_ts        INTEGER DEFAULT 0,
    atualizado_em TEXT
  );
`);

// ── Atualização de Preço ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS atualizacoes_preco (
    id            INTEGER PRIMARY KEY,
    dados         TEXT    NOT NULL,
    log_ts        INTEGER DEFAULT 0,
    atualizado_em TEXT
  );
`);

// ── Tombstones ────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS tombstones (
    tabela TEXT NOT NULL,
    id     INTEGER NOT NULL,
    deletado_em TEXT,
    PRIMARY KEY (tabela, id)
  );
`);
const addTombstone  = db.prepare('INSERT OR IGNORE INTO tombstones (tabela,id,deletado_em) VALUES (?,?,?)');
const hasTombstone  = db.prepare('SELECT 1 FROM tombstones WHERE tabela=? AND id=?');
const allTombstones = db.prepare('SELECT tabela, id FROM tombstones');

const upsertModelagem = db.prepare(`
  INSERT INTO modelagens (id, dados, log_ts, atualizado_em) VALUES (?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    dados         = CASE WHEN excluded.log_ts >= log_ts THEN excluded.dados ELSE dados END,
    log_ts        = MAX(log_ts, excluded.log_ts),
    atualizado_em = excluded.atualizado_em
`);
const upsertAtuPreco = db.prepare(`
  INSERT INTO atualizacoes_preco (id, dados, log_ts, atualizado_em) VALUES (?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    dados         = CASE WHEN excluded.log_ts >= log_ts THEN excluded.dados ELSE dados END,
    log_ts        = MAX(log_ts, excluded.log_ts),
    atualizado_em = excluded.atualizado_em
`);

const upsertCadastro = db.prepare(`
  INSERT INTO cadastros (id, dados, criado_em, atualizado_em) VALUES (?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET dados=excluded.dados, atualizado_em=excluded.atualizado_em
`);
const upsertFrete = db.prepare(`
  INSERT INTO fretes (id, dados, log_ts, atualizado_em) VALUES (?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    dados         = CASE WHEN excluded.log_ts >= log_ts THEN excluded.dados ELSE dados END,
    log_ts        = MAX(log_ts, excluded.log_ts),
    atualizado_em = excluded.atualizado_em
`);
const upsertLogo = db.prepare(`
  INSERT INTO aplicacoes_logo (id, dados, log_ts, atualizado_em) VALUES (?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    dados         = CASE WHEN excluded.log_ts >= log_ts THEN excluded.dados ELSE dados END,
    log_ts        = MAX(log_ts, excluded.log_ts),
    atualizado_em = excluded.atualizado_em
`);
const upsertCfg = db.prepare(`INSERT INTO config (chave,valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor`);
const maxCfg    = db.prepare(`INSERT INTO config (chave,valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=MAX(CAST(valor AS INTEGER),CAST(excluded.valor AS INTEGER))`);

// ── Montar estado ─────────────────────────────────────────────────────────────
function stripBinarios(obj) {
  const copia = Object.assign({}, obj);
  delete copia.pdf_receita;
  return copia;
}

function montarEstado() {
  const cadastros         = db.prepare('SELECT dados FROM cadastros      ORDER BY id').all().map(r => stripBinarios(JSON.parse(r.dados)));
  const fretes            = db.prepare('SELECT dados FROM fretes         ORDER BY id').all().map(r => stripBinarios(JSON.parse(r.dados)));
  const aplicacoesLogo    = db.prepare('SELECT dados FROM aplicacoes_logo ORDER BY id DESC').all().map(r => stripBinarios(JSON.parse(r.dados)));
  const modelagens        = db.prepare('SELECT dados FROM modelagens ORDER BY id DESC').all().map(r => stripBinarios(JSON.parse(r.dados)));
  const atualizacoesPreco = db.prepare('SELECT dados FROM atualizacoes_preco ORDER BY id DESC').all().map(r => JSON.parse(r.dados));
  const cfg = {};
  db.prepare('SELECT chave,valor FROM config').all().forEach(r => {
    try { cfg[r.chave] = JSON.parse(r.valor); } catch(_) { cfg[r.chave] = r.valor; }
  });
  const tombstones = allTombstones.all();
  return { cadastros, fretes, aplicacoesLogo, modelagens, atualizacoesPreco, tombstones, ...cfg, atualizado_em: new Date().toISOString() };
}

// ── Salvar estado ─────────────────────────────────────────────────────────────
const CHAVES_CONFIG = ['VENDEDORAS','TRANSPORTADORAS','FORMAS_PAGAMENTO',
                       'shadows_logo_menu','shadows_logo_login','shadows_logo_pdf','usuariosConfig'];

const salvarTransacao = db.transaction((incoming) => {
  const now = new Date().toISOString();
  (incoming.cadastros || []).forEach(c => {
    if (hasTombstone.get('cadastros', c.id)) return;
    if (!c.pdf_receita) {
      try {
        const row = db.prepare('SELECT dados FROM cadastros WHERE id=?').get(c.id);
        if (row) { const d = JSON.parse(row.dados); if (d.pdf_receita) { c = Object.assign({}, c, { pdf_receita: d.pdf_receita, pdf_receita_nome: d.pdf_receita_nome }); } }
      } catch(_) {}
    }
    upsertCadastro.run(c.id, JSON.stringify(c), c.criado_em || now, now);
  });
  (incoming.fretes           || []).forEach(f => { if (!hasTombstone.get('fretes',      f.id)) upsertFrete.run(f.id, JSON.stringify(f), maxLogTs(f), now); });
  (incoming.aplicacoesLogo   || []).forEach(a => { if (!hasTombstone.get('logos',       a.id)) upsertLogo.run(a.id, JSON.stringify(a), maxLogTs(a), now); });
  (incoming.modelagens       || []).forEach(m => { if (!hasTombstone.get('modelagens',  m.id)) upsertModelagem.run(m.id, JSON.stringify(m), maxLogTs(m), now); });
  (incoming.atualizacoesPreco || []).forEach(a => { upsertAtuPreco.run(a.id, JSON.stringify(a), maxLogTs(a), now); });
  ['nextId','nextLogoId','nextFreteId','nextModelagemId','nextAtualizacaoPrecoId'].forEach(k => {
    if (typeof incoming[k] === 'number') maxCfg.run(k, String(incoming[k]));
  });
  CHAVES_CONFIG.forEach(k => {
    if (incoming[k] !== undefined) upsertCfg.run(k, JSON.stringify(incoming[k]));
  });
  if (Array.isArray(incoming.tabelaPrecos) && incoming.tabelaPrecos.length > 0) {
    const row = db.prepare('SELECT valor FROM config WHERE chave=?').get('tabelaPrecos');
    const atual = row ? JSON.parse(row.valor) : [];
    const mapa = {};
    atual.forEach(p => { if (p.ref) mapa[p.ref.toUpperCase()] = p; });
    incoming.tabelaPrecos.forEach(p => { if (p.ref) mapa[p.ref.toUpperCase()] = p; });
    upsertCfg.run('tabelaPrecos', JSON.stringify(Object.values(mapa)));
  }
});

// ── Backup diário ─────────────────────────────────────────────────────────────
function backupDiario() {
  const hoje = new Date().toISOString().slice(0, 10);
  const arq  = path.join(BACKUP_DIR, 'estado-' + hoje + '.json');
  if (!fs.existsSync(arq)) {
    try { fs.writeFile(arq, JSON.stringify(montarEstado()), () => {}); } catch(_) {}
  }
}

// ── Recuperar produtos ────────────────────────────────────────────────────────
function recuperarProdutosSeVazio() {
  try {
    if (fs.existsSync(PRODUTOS_FILE)) {
      const atual = JSON.parse(fs.readFileSync(PRODUTOS_FILE, 'utf-8'));
      if (Array.isArray(atual) && atual.length > 0) return;
    }
    const fontes = [ESTADO_LEGADO,
      ...(fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).sort().reverse()
        .map(f => path.join(BACKUP_DIR, f)) : [])];
    for (const fonte of fontes) {
      try {
        const d = JSON.parse(fs.readFileSync(fonte, 'utf-8'));
        if (Array.isArray(d.produtos) && d.produtos.length > 0) {
          fs.writeFileSync(PRODUTOS_FILE, JSON.stringify(d.produtos));
          console.log('Produtos recuperados de ' + path.basename(fonte));
          return;
        }
      } catch(_) {}
    }
  } catch(err) { console.error('Erro ao recuperar produtos:', err.message); }
}
recuperarProdutosSeVazio();

// ═══════════════════════════════════════════════════════════════════════════════
// ROTAS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/estado', (req, res) => {
  try { res.json(montarEstado()); }
  catch(err) { res.status(500).json({ erro: 'Nao foi possivel ler os dados.', detalhe: err.message }); }
});

app.post('/api/estado', express.json({ limit: '50mb' }), (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ erro: 'Corpo invalido.' });
    salvarTransacao(incoming);
    backupDiario();
    res.json({ ok: true, atualizado_em: new Date().toISOString() });
  } catch(err) {
    console.error('[Shadows POST] ERRO ao salvar:', err.message);
    res.status(500).json({ erro: 'Nao foi possivel salvar os dados.', detalhe: err.message });
  }
});

app.get('/api/debug', (req, res) => {
  try {
    res.json({
      cadastros: db.prepare('SELECT COUNT(*) as n FROM cadastros').get().n,
      fretes: db.prepare('SELECT COUNT(*) as n FROM fretes').get().n,
      aplicacoes_logo: db.prepare('SELECT COUNT(*) as n FROM aplicacoes_logo').get().n,
      modelagens: db.prepare('SELECT COUNT(*) as n FROM modelagens').get().n,
      atualizacoes_preco: db.prepare('SELECT COUNT(*) as n FROM atualizacoes_preco').get().n,
    });
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/api/cadastros/:id', (req, res) => {
  try { const id = Number(req.params.id); db.prepare('DELETE FROM cadastros WHERE id=?').run(id); addTombstone.run('cadastros', id, new Date().toISOString()); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ erro: err.message }); }
});
app.delete('/api/fretes/:id', (req, res) => {
  try { const id = Number(req.params.id); db.prepare('DELETE FROM fretes WHERE id=?').run(id); addTombstone.run('fretes', id, new Date().toISOString()); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ erro: err.message }); }
});
app.delete('/api/aplicacoes-logo/:id', (req, res) => {
  try { const id = Number(req.params.id); db.prepare('DELETE FROM aplicacoes_logo WHERE id=?').run(id); addTombstone.run('logos', id, new Date().toISOString()); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ erro: err.message }); }
});
app.delete('/api/modelagens/:id', (req, res) => {
  try { const id = Number(req.params.id); db.prepare('DELETE FROM modelagens WHERE id=?').run(id); addTombstone.run('modelagens', id, new Date().toISOString()); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ erro: err.message }); }
});
app.delete('/api/atupreco/:id', (req, res) => {
  try { const id = Number(req.params.id); db.prepare('DELETE FROM atualizacoes_preco WHERE id=?').run(id); addTombstone.run('atupreco', id, new Date().toISOString()); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/backup', (req, res) => {
  try {
    const estado = montarEstado();
    const fname  = 'shadows-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
    res.send(JSON.stringify(estado, null, 2));
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/saude', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/api/produtos', (req, res) => {
  try {
    if (!fs.existsSync(PRODUTOS_FILE)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(PRODUTOS_FILE, 'utf-8')));
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/produtos', async (req, res) => {
  try {
    const lista = req.body;
    if (!Array.isArray(lista)) return res.status(400).json({ erro: 'Esperado array.' });
    const tmp = PRODUTOS_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(lista));
    await fs.promises.rename(tmp, PRODUTOS_FILE);
    res.json({ ok: true, total: lista.length });
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/recuperar-produtos', (req, res) => {
  recuperarProdutosSeVazio();
  try {
    const atual = fs.existsSync(PRODUTOS_FILE) ? JSON.parse(fs.readFileSync(PRODUTOS_FILE, 'utf-8')) : [];
    res.json({ ok: true, total: atual.length });
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

// ── Geração de PDF via Chrome headless ────────────────────────────────────────
app.post('/api/gerar-pdf', express.json({ limit: '20mb' }), (req, res) => {
  const { html, filename } = req.body || {};
  if (!html) return res.status(400).json({ erro: 'HTML ausente.' });
  const os       = require('os');
  const tmpDir   = os.tmpdir();
  const base     = 'orcamento_' + Date.now();
  const htmlFile = path.join(tmpDir, base + '.html');
  const pdfFile  = path.join(tmpDir, base + '.pdf');
  fs.writeFileSync(htmlFile, html, 'utf-8');

  // Suporta Windows e Linux (Railway)
  const chromePaths = [
    process.env.CHROME_PATH,
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Linux
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ].filter(Boolean);

  const chrome = chromePaths.find(p => fs.existsSync(p));
  if (!chrome) {
    try { fs.unlinkSync(htmlFile); } catch(_) {}
    return res.status(500).json({ erro: 'Chrome nao encontrado no servidor.' });
  }
  const { exec } = require('child_process');
  const htmlUrl = 'file:///' + htmlFile.replace(/\\/g, '/');
  const args = '--headless --disable-gpu --no-sandbox --disable-dev-shm-usage --print-to-pdf="' + pdfFile + '" --print-to-pdf-no-header --no-pdf-header-footer';
  exec('"' + chrome + '" ' + args + ' "' + htmlUrl + '"', { timeout: 30000 }, (err) => {
    try { fs.unlinkSync(htmlFile); } catch(_) {}
    if (err || !fs.existsSync(pdfFile)) {
      return res.status(500).json({ erro: 'Falha ao gerar PDF.', detalhe: err ? err.message : 'PDF nao gerado.' });
    }
    const pdf = fs.readFileSync(pdfFile);
    try { fs.unlinkSync(pdfFile); } catch(_) {}
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + (filename || 'orcamento.pdf') + '"');
    res.send(pdf);
  });
});

// ── Upload de arquivos ────────────────────────────────────────────────────────
app.post('/api/upload', express.json({ limit: '20mb' }), (req, res) => {
  try {
    const { data, nome } = req.body || {};
    if (!data || typeof data !== 'string' || !data.startsWith('data:'))
      return res.status(400).json({ erro: 'Campo "data" ausente ou inválido.' });
    const match = data.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) return res.status(400).json({ erro: 'Formato base64 inválido.' });

    // Verificar tipo de arquivo pela extensão
    const nomeExt = ((nome || '').split('.').pop() || '').toLowerCase();
    const PERMITIDOS = ['jpg','jpeg','png','pdf','cdr','cdrx','ai','mp4','mov','avi','wmv','webm','mkv'];
    if (nomeExt && !PERMITIDOS.includes(nomeExt)) {
      return res.status(400).json({ erro: `Tipo de arquivo não permitido (.${nomeExt}). Permitidos: JPG, PNG, PDF, CDR, MP4, MOV, AVI e outros vídeos.` });
    }

    // Verificar tamanho (máx 100MB)
    const buffer = Buffer.from(match[2], 'base64');
    const MAX_BYTES = 10 * 1024 * 1024;
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({ erro: `Arquivo muito grande (${(buffer.length/1024/1024).toFixed(0)}MB). Limite: 10MB.` });
    }

    const mime = match[1];
    const ext  = nomeExt || (mime.split('/')[1] || 'bin').split('+')[0].replace(/[^a-z0-9]/g, '');
    const safe = (nome || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
    const fileName = Date.now() + '-' + Math.random().toString(36).slice(2, 7) + (safe ? '-' + safe : '') + '.' + ext;
    const filePath = path.join(UPLOADS_DIR, fileName);
    fs.writeFileSync(filePath, buffer);
    res.json({ ok: true, url: '/files/' + fileName });
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

app.use('/files', express.static(UPLOADS_DIR));

// TEMPORÁRIO: upload de arquivo preservando nome original
app.post('/api/admin/upload-file', express.raw({ limit: '50mb', type: '*/*' }), (req, res) => {
  const secret = req.headers['x-upload-secret'];
  if (secret !== 'shadows2026migra') return res.status(403).json({ erro: 'forbidden' });
  const filename = (req.headers['x-filename'] || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!filename) return res.status(400).json({ erro: 'x-filename obrigatorio' });
  try {
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.body);
    res.json({ ok: true, filename });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── Frontend ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'DEMO.html')));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err && (err.type === 'request.aborted' || err.message === 'request aborted')) return;
  console.error('[Shadows] Erro:', err.message);
  if (!res.headersSent) res.status(500).json({ erro: 'Erro interno.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Servidor Shadows rodando na porta ' + PORT);
  console.log('DATA_DIR:', DATA_DIR);
  try {
    const n = db.prepare('SELECT COUNT(*) as n FROM atualizacoes_preco').get().n;
    console.log('[Shadows] Tabela atualizacoes_preco OK (' + n + ' registro(s))');
  } catch(e) {}
});
