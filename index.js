const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const MEU_NUMERO = process.env.MEU_NUMERO; // ex: 5512999999999

// ── Parser de linguagem natural ──
function extractVal(t) {
  let s = t.replace(/r\$\s*/gi, '').replace(/-/g, ' ').trim();
  let km = s.match(/(\d+(?:[.,]\d+)?)\s*k\b/i);
  if (km) return parseFloat(km[1].replace(',', '.')) * 1000;
  let m = s.match(/(\d{1,3}(?:\.\d{3})+),(\d{1,2})\b/);
  if (m) return parseFloat(m[0].replace(/\./g, '').replace(',', '.'));
  m = s.match(/(\d{1,3}(?:\.\d{3})+)\b(?![,\d])/);
  if (m) return parseFloat(m[0].replace(/\./g, ''));
  m = s.match(/(\d+),(\d{1,2})\b/);
  if (m) return parseFloat(m[1] + '.' + m[2]);
  m = s.match(/(\d+)\.(\d{2})\b(?!\d)/);
  if (m) return parseFloat(m[0]);
  m = s.match(/\d+/);
  if (m) return parseInt(m[0]);
  return null;
}

function detectCat(t) {
  const l = t.toLowerCase();
  const rules = [
    ['Transporte', ['uber', '99', 'taxi', 'gasolina', 'combustivel', 'estacionamento', 'passagem']],
    ['Alimentação', ['almoço', 'jantar', 'café', 'lanche', 'pizza', 'restaurante', 'ifood', 'hamburger', 'padaria', 'sushi', 'comida']],
    ['Mercado', ['mercado', 'supermercado', 'feira', 'hortifruti']],
    ['Saúde', ['farmácia', 'farmacia', 'remédio', 'médico', 'consulta', 'exame', 'hospital', 'dentista']],
    ['Lazer', ['cinema', 'netflix', 'spotify', 'jogo', 'show', 'ingresso', 'streaming']],
    ['Moradia', ['aluguel', 'condomínio', 'luz', 'água', 'internet', 'energia', 'iptu']],
    ['Investimentos', ['investimento', 'invest', 'ação', 'fundo', 'cdb', 'tesouro', 'cripto', 'bitcoin']],
    ['Educação', ['curso', 'escola', 'faculdade', 'livro', 'mensalidade', 'aula']],
  ];
  for (const [cat, words] of rules) {
    if (words.some(w => l.includes(w))) return cat;
  }
  return 'Outros';
}

function parseParcela(text) {
  const t = text.toLowerCase();
  const patterns = [
    /(\d+)\s*[xX×]\s*(?:de\s+)?r?\$?\s*([\d.,]+)\s*k?/,
    /(\d+)\s*vezes?\s*(?:de\s+)?r?\$?\s*([\d.,]+)\s*k?/,
  ];
  for (const pat of patterns) {
    const m = t.match(pat);
    if (m) {
      const n = parseInt(m[1]);
      const hasK = /k\b/i.test(text.slice(text.toLowerCase().indexOf(m[2])));
      const val = extractVal(m[2]) * (hasK ? 1000 : 1);
      if (n >= 2 && n <= 72 && val > 0) return { n, val };
    }
  }
  return null;
}

function cleanDesc(t) {
  let d = t
    .replace(/r\$\s*[\d.,]+/gi, '')
    .replace(/\d+\s*[xX×]\s*(?:de\s+)?[\d.,]+\s*k?/gi, '')
    .replace(/[\d.,]+\s*k?\s*(reais|real)?/gi, '')
    .replace(/-/g, ' ')
    .replace(/\b(gastei|paguei|comprei|no|na|de|do|da|em|com|pelo|pela|um|uma)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  return d ? d.charAt(0).toUpperCase() + d.slice(1) : 'Gasto';
}

function todayStr() {
  return new Date().toLocaleDateString('pt-BR');
}

function fmt(v) {
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Envia mensagem via Z-API ──
async function sendMessage(phone, text) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, message: text })
  });
}

// ── Salva lançamento no Supabase ──
async function saveExpense(item) {
  const { error } = await supabase.from('expenses').insert({
    id: String(Date.now() + Math.random()),
    descricao: item.desc,
    valor: item.valor,
    categoria: item.categoria,
    conta: 'Pessoal',
    pagto: '',
    data: item.data || todayStr(),
    tipo: item.tipo || 'saida',
    obs: item.obs || '',
    tags: [],
    status: 'efetivada',
  });
  return !error;
}

// ── Busca resumo do mês ──
async function getResumo() {
  const today = new Date();
  const mes = String(today.getMonth() + 1).padStart(2, '0');
  const ano = String(today.getFullYear());

  const { data } = await supabase
    .from('expenses')
    .select('valor, tipo, categoria')
    .like('data', `%/${mes}/${ano}`);

  if (!data || !data.length) return null;

  const saidas = data.filter(e => e.tipo !== 'entrada').reduce((s, e) => s + (e.valor || 0), 0);
  const entradas = data.filter(e => e.tipo === 'entrada').reduce((s, e) => s + (e.valor || 0), 0);

  // Top categorias
  const byCat = {};
  data.filter(e => e.tipo !== 'entrada').forEach(e => {
    byCat[e.categoria] = (byCat[e.categoria] || 0) + e.valor;
  });
  const topCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 3);

  return { saidas, entradas, saldo: entradas - saidas, topCats, total: data.length };
}

// ── Processa mensagem recebida ──
async function processMessage(phone, text) {
  const t = text.trim().toLowerCase();

  // Comandos especiais
  if (t === 'resumo' || t === 'saldo' || t === 'como estou') {
    const r = await getResumo();
    if (!r) return await sendMessage(phone, '📊 Nenhum lançamento este mês ainda.');

    const cats = r.topCats.map(([cat, val]) => `  • ${cat}: ${fmt(val)}`).join('\n');
    return await sendMessage(phone,
      `📊 *Resumo de ${new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}*\n\n` +
      `📥 Entradas: ${fmt(r.entradas)}\n` +
      `📤 Saídas: ${fmt(r.saidas)}\n` +
      `💰 Saldo: ${fmt(r.saldo)}\n\n` +
      `🔝 Top categorias:\n${cats}\n\n` +
      `📌 ${r.total} lançamentos`
    );
  }

  if (t === 'ajuda' || t === 'help' || t === '?') {
    return await sendMessage(phone,
      `🤖 *Gastei Bot - Comandos*\n\n` +
      `💸 *Lançar saída:*\n  Mercado 150\n  Uber 25,50\n  Relógio 10x de 4k\n\n` +
      `📥 *Lançar entrada:*\n  entrada salário 8000\n  recebi 500\n\n` +
      `📊 *Ver resumo:*\n  resumo\n  saldo\n\n` +
      `❌ *Cancelar último:*\n  desfazer\n  cancelar`
    );
  }

  if (t === 'desfazer' || t === 'cancelar' || t === 'undo') {
    const { data } = await supabase
      .from('expenses')
      .select('id, descricao, valor')
      .order('created_at', { ascending: false })
      .limit(1);

    if (!data || !data.length) return await sendMessage(phone, '❌ Nenhum lançamento para desfazer.');

    const last = data[0];
    await supabase.from('expenses').delete().eq('id', last.id);
    return await sendMessage(phone, `✅ Desfeito: "${last.descricao}" ${fmt(last.valor)}`);
  }

  // Detecta entrada
  const isEntrada = /^(entrada|recebi|receita|salário|salario)\s+/i.test(text);
  const textoParsear = text.replace(/^(entrada|recebi|receita|salário|salario)\s+/i, '');

  // Detecta parcela
  const parcela = parseParcela(textoParsear);
  if (parcela) {
    const desc = cleanDesc(textoParsear);
    const cat = detectCat(textoParsear);
    const total = parcela.n * parcela.val;

    // Salva primeira parcela
    await saveExpense({
      desc: `${desc} (1/${parcela.n})`,
      valor: parcela.val,
      categoria: cat,
      tipo: 'saida'
    });

    return await sendMessage(phone,
      `✅ *${desc}*\n` +
      `📅 ${parcela.n}x de ${fmt(parcela.val)}\n` +
      `💰 Total: ${fmt(total)}\n` +
      `🏷 ${cat}\n\n` +
      `_1ª parcela lançada. As demais serão lançadas automaticamente._`
    );
  }

  // Lançamento simples
  const valor = extractVal(textoParsear);
  if (!valor || valor <= 0) {
    return await sendMessage(phone,
      `❓ Não entendi o valor. Tente:\n  Mercado 150\n  Uber 25,50\n  entrada salário 8000\n\nDigite *ajuda* para ver todos os comandos.`
    );
  }

  const desc = cleanDesc(textoParsear);
  const cat = detectCat(textoParsear);
  const tipo = isEntrada ? 'entrada' : 'saida';

  const ok = await saveExpense({ desc, valor, categoria: cat, tipo });

  if (ok) {
    const emoji = tipo === 'entrada' ? '📥' : '📤';
    return await sendMessage(phone,
      `${emoji} *${desc}*\n` +
      `💰 ${fmt(valor)}\n` +
      `🏷 ${cat}\n` +
      `📅 ${todayStr()}`
    );
  } else {
    return await sendMessage(phone, '❌ Erro ao salvar. Tente novamente.');
  }
}

// ── Webhook Z-API ──
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responde rápido pro Z-API

  try {
    const body = req.body;

    // Ignora mensagens enviadas por mim mesmo e grupos
    if (body.fromMe || body.isGroup) return;

    const phone = body.phone;
    const text = body.text?.message || body.text;

    if (!text || typeof text !== 'string') return;

    // Só responde pro meu número
    if (MEU_NUMERO && !phone.includes(MEU_NUMERO.replace(/\D/g, ''))) return;

    await processMessage(phone, text);
  } catch (err) {
    console.error('Erro webhook:', err);
  }
});

app.get('/', (req, res) => res.json({ status: 'Gastei Bot online 🤖' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gastei Bot rodando na porta ${PORT}`));
