const $ = id => document.getElementById(id);
const state = { current: null, game: null, tab: 'chat', logged: false, busy: false };
const statusNames = { lobby: 'Preparação', running: 'Em jogo', paused: 'Pausado', finished: 'Concluído' };
const phaseNames = { discussion: 'Negociação', decision: 'Decisão privada', finished: 'Concluído' };
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const color = id => [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 6;
const nameOf = id => state.game?.players.find(p => p.id === id)?.name || 'Sistema';
const avatar = p => node('div', `avatar c${color(p.id)}`, p.name.slice(0, 2).toUpperCase());
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const payload = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') showLogin();
    throw new Error(payload.error || `Falha HTTP ${res.status}`);
  }
  return payload;
}
function showLogin() { state.logged = false; $('workspace').hidden = true; $('login').hidden = false; }
function showWorkspace() { state.logged = true; $('workspace').hidden = false; $('login').hidden = true; }
function openModal(markup) { $('modal-body').innerHTML = markup; if (!$('modal').open) $('modal').showModal(); }
$('modal').addEventListener('close', () => { $('modal-body').replaceChildren(); });
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado.'); }
  catch { toast('Selecione o texto no quadro e copie manualmente.'); }
}
function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const a = node('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('login-form').addEventListener('submit', async e => {
  e.preventDefault(); const button = e.submitter; button.disabled = true; $('login-error').textContent = '';
  try { await api('/api/login', { token: $('admin-key').value }); $('admin-key').value = ''; showWorkspace(); await refresh(); }
  catch (err) { $('login-error').textContent = err.message; }
  finally { button.disabled = false; }
});
$('logout').onclick = async () => { try { await api('/api/logout', {}); } catch {} showLogin(); };

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    const list = await api('/api/matches'); showWorkspace();
    if (!state.current || !list.some(g => g.id === state.current)) state.current = list[0]?.id || null;
    renderSessions(list);
    if (state.current) {
      const selected = state.current;
      const g = await api(`/api/matches/${selected}`);
      if (selected === state.current && (g.id !== state.game?.id || g.revision !== state.game?.revision)) { state.game = g; renderGame(); }
    } else { state.game = null; $('empty').hidden = false; $('match-content').hidden = true; }
    $('sync-status').classList.remove('offline'); $('sync-status').replaceChildren(node('span', 'status-dot'), document.createTextNode('Sincronizado'));
  } catch (err) {
    if (state.logged) { $('sync-status').classList.add('offline'); $('sync-status').replaceChildren(node('span', 'status-dot'), document.createTextNode('Reconectando')); }
  } finally { state.busy = false; }
}
function renderSessions(list) {
  const fragment = document.createDocumentFragment();
  for (const g of list) {
    const b = node('button', `session-item${g.id === state.current ? ' active' : ''}`); b.title = `${g.name} · ${statusNames[g.status]}`;
    b.append(node('span', '', g.status === 'running' ? '◉' : '○'), node('span', 'session-name', g.name), node('span', 'session-round', `R${String(g.round).padStart(2, '0')}`));
    b.onclick = () => { state.current = g.id; state.game = null; refresh(); }; fragment.append(b);
  }
  $('sessions').replaceChildren(fragment);
}
function renderGame() {
  const g = state.game; $('empty').hidden = true; $('match-content').hidden = false;
  $('match-name').textContent = g.name; $('round-metric').textContent = `${String(g.round).padStart(2, '0')} / ${String(g.maxRounds).padStart(2, '0')}`;
  $('target-metric').textContent = `${g.target} pts`; $('phase-metric').textContent = g.status === 'running' ? phaseNames[g.phase] : statusNames[g.status];
  const controls = [];
  const addControl = (label, command, cls) => {
    const b = node('button', cls, label); b.disabled = command === 'start' && g.players.length < 2;
    b.onclick = async () => {
      if (command === 'stop') { confirmStop(g.id); return; }
      b.disabled = true;
      try { await api(`/api/matches/${g.id}/control`, { command }); await refresh(); }
      catch (err) { toast(err.message); } finally { b.disabled = false; }
    }; controls.push(b);
  };
  if (g.status === 'lobby') addControl('Iniciar sessão ↗', 'start', 'primary');
  if (g.status === 'running') addControl('Ⅱ Pausar', 'pause', 'secondary');
  if (g.status === 'paused') addControl('▷ Continuar', 'resume', 'primary');
  if (g.status !== 'finished') addControl('Encerrar', 'stop', 'secondary');
  $('controls').replaceChildren(...controls);
  $('result-banner').hidden = g.status !== 'finished';
  if (g.status === 'finished') {
    const event = g.events.findLast(e => e.type === 'result');
    $('result-banner').replaceChildren(node('span', 'result-label', g.winner ? 'RESULTADO OFICIAL / VENCEDOR CONFIRMADO' : 'RESULTADO OFICIAL'), node('strong', '', event?.content || 'Sessão concluída.'), node('div', 'field-hint', `${g.acknowledgements.length} de ${g.players.length} agentes confirmaram o recebimento do resultado.`));
  }
  $('agent-count').textContent = `${g.players.length} / 6`;
  const agents = [...g.players].sort((a, b) => b.score - a.score).map(p => {
    const r = node('div', 'agent-row'), detail = node('div', 'agent-detail');
    detail.append(node('strong', 'agent-name', `${p.name}${g.winner === p.id ? ' ↗' : ''}`), node('span', 'agent-model', p.model));
    let label = p.connectedAt ? 'MCP inicializado' : 'Aguardando executor';
    if (g.acknowledgements.includes(p.id)) label = 'Resultado recebido';
    else if (g.submitted.includes(p.id)) label = 'Decisão entregue';
    else if (g.speaker === p.id) label = 'Vez de falar';
    detail.append(node('span', 'agent-state', label));
    const score = node('div', 'agent-score'); score.append(node('strong', '', String(p.score).padStart(2, '0')), node('small', '', 'PONTOS'));
    const rotate = node('button', 'rotate-token', '↻'); rotate.title = `Gerar novo token de ${p.name}`; rotate.setAttribute('aria-label', rotate.title); rotate.onclick = () => rotateToken(p);
    r.append(avatar(p), detail, score, rotate); return r;
  });
  if (!agents.length) { const p = node('p', 'agent-empty field-hint', 'Nenhum agente conectado. Cadastre os participantes para começar.'); agents.push(p); }
  $('agents').replaceChildren(...agents);
  $('add-agent').disabled = g.status !== 'lobby' || g.players.length >= 6;
  $('add-agent').textContent = g.status !== 'lobby' ? 'Inscrições encerradas' : '+ Conectar agente';
  $('message-count').textContent = String(g.events.filter(e => ['message', 'reaction'].includes(e.type)).length);
  $('turn-status').textContent = g.status === 'lobby' ? 'Aguardando início da sessão' : g.status === 'paused' ? 'Sessão pausada pelo operador' : g.status === 'finished' ? 'Resultado anunciado a todos os agentes' : g.phase === 'discussion' ? `↳ A palavra está com ${nameOf(g.speaker)}` : `Decisões privadas · ${g.submitted.length} de ${g.players.length} entregues`;
  renderConversation();
}
function renderConversation() {
  const g = state.game; if (!g) return;
  const el = $('conversation'), atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const events = state.tab === 'chat' ? g.events.filter(e => ['message', 'reaction', 'round_result', 'result'].includes(e.type)) : g.events;
  const fragment = document.createDocumentFragment(); let round = 0;
  if (!events.length) {
    const empty = node('div', 'chat-empty'); empty.append(node('div', 'empty-symbol', '⌑'), node('h3', '', 'A conversa começa pelos agentes.'), node('p', '', 'Conecte o executor no notebook e inicie a sessão. As mensagens entre os modelos aparecem aqui em tempo real.')); fragment.append(empty);
  }
  for (const event of events) {
    if (event.round !== round) { round = event.round; fragment.append(node('div', 'round-divider', `RODADA ${String(round).padStart(2, '0')}`)); }
    if (event.type === 'message' || event.type === 'reaction') {
      const p = g.players.find(p => p.id === event.actor); if (!p) continue;
      const message = node('article', 'message'), main = node('div'), meta = node('div', 'message-meta');
      const time = node('time', '', new Date(event.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })); time.dateTime = event.at;
      meta.append(node('strong', '', p.name), node('span', 'model', p.model), time);
      main.append(meta, node('div', 'message-target', event.type === 'reaction' ? '↳ REAÇÃO AO RESULTADO' : `→ ${event.to === 'all' ? 'PARA A MESA' : nameOf(event.to).toUpperCase()} · PÚBLICO`), node('p', 'message-body', event.content));
      message.append(avatar(p), main); fragment.append(message);
    } else if (event.type === 'round_result') {
      const r = node('div', 'round-results'); r.append(node('h4', '', 'DECISÕES REVELADAS / PONTOS DA RODADA'));
      for (const [id, action] of Object.entries(event.actions)) { const line = node('div', 'decision-row'); line.append(node('span', '', nameOf(id)), node('span', '', action === 'cooperate' ? 'COOPEROU' : 'TRAIU'), node('b', '', `+${event.delta[id]}`)); r.append(line); }
      fragment.append(r);
    } else { const line = node('div', 'event-row'); line.append(node('span', 'event-line'), node('span', '', event.content)); fragment.append(line); }
  }
  el.replaceChildren(fragment); if (atBottom) el.scrollTop = el.scrollHeight;
}
for (const [id, tab] of [['tab-chat', 'chat'], ['tab-log', 'log']]) $(id).onclick = () => {
  state.tab = tab; for (const [t, k] of [['tab-chat', 'chat'], ['tab-log', 'log']]) { $(t).classList.toggle('active', k === tab); $(t).setAttribute('aria-selected', String(k === tab)); } renderConversation();
};
function newMatch() {
  openModal(`<div class="eyebrow">NOVA SESSÃO / CONFIGURAÇÃO</div><h2 class="modal-title">Prepare a mesa.</h2><p class="modal-subtitle">Os modelos têm o mesmo objetivo: terminar como líder único acima da meta.</p><form id="create-form"><div class="fields"><label>Nome da sessão<input name="name" maxlength="80" placeholder="Ex. Experimento de confiança 01" required></label><div class="field-row"><label>Meta de pontos<input name="target" type="number" min="5" max="500" value="30" required></label><label>Limite de rodadas<input name="maxRounds" type="number" min="1" max="100" value="20" required></label></div><label>Falas por agente antes de cada decisão<select name="cycles"><option value="1">1 fala · conversa curta</option><option value="2" selected>2 falas · proposta e resposta</option><option value="3">3 falas · negociação estendida</option><option value="5">5 falas · negociação longa</option></select></label><small>De 2 a 6 agentes. Os pontos são somados contra cada adversário; mais participantes aceleram o placar. Pode haver empate ao atingir o limite de rodadas.</small></div><div id="form-error" class="error" role="alert"></div><div class="modal-actions"><button class="primary">Criar sessão ↗</button></div></form>`);
  $('create-form').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target); e.submitter.disabled = true;
    try { const g = await api('/api/matches', { name: f.get('name'), target: Number(f.get('target')), maxRounds: Number(f.get('maxRounds')), cycles: Number(f.get('cycles')) }); state.current = g.id; $('modal').close(); await refresh(); }
    catch (err) { $('form-error').textContent = err.message; e.submitter.disabled = false; }
  };
}
for (const id of ['new-sidebar', 'new-match', 'new-empty']) $(id).onclick = newMatch;
$('add-agent').onclick = () => {
  openModal(`<div class="eyebrow">AGENTE / CREDENCIAL MCP</div><h2 class="modal-title">Mais uma voz na mesa.</h2><p class="modal-subtitle">Cada agente tem identidade e token próprios. O modelo será executado no notebook pelo OpenRouter.</p><form id="agent-form"><div class="fields"><label>Nome do agente<input name="name" maxlength="40" placeholder="Ex. Atlas" required></label><label>Identificador do modelo no OpenRouter<input name="model" maxlength="120" placeholder="provedor/modelo" required></label><small>Use o identificador exato de um modelo com suporte a ferramentas. Você poderá rodar vários agentes com a mesma chave ou com chaves diferentes.</small></div><div class="error" id="form-error" role="alert"></div><div class="modal-actions"><button class="primary">Gerar conexão ↗</button></div></form>`);
  $('agent-form').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target); e.submitter.disabled = true;
    try { const credential = await api(`/api/matches/${state.current}/players`, Object.fromEntries(f)); showCredential(credential); await refresh(); }
    catch (err) { $('form-error').textContent = err.message; e.submitter.disabled = false; }
  };
};
function showCredential(c) {
  const config = JSON.stringify({ arena_url: location.origin, agents: [{ name: c.player.name, token: c.token, openrouter_key_env: 'OPENROUTER_API_KEY' }] }, null, 2);
  openModal(`<div class="eyebrow">CONEXÃO GERADA</div><h2 class="modal-title">Pronto para conectar.</h2><p class="modal-subtitle">Salve a credencial agora. O token só é mostrado uma vez. A chave do OpenRouter será lida do ambiente no notebook.</p><pre id="credential" class="code-block"></pre><div class="field-hint">Execute: <code>python runner/run.py --config agente.json</code><br>Você pode passar vários arquivos depois de <code>--config</code>.</div><div class="modal-actions"><button id="copy-credential" class="secondary">Copiar</button><button id="download-credential" class="primary">Baixar agente.json ↓</button></div>`);
  $('credential').textContent = config;
  $('copy-credential').onclick = () => copy(config);
  $('download-credential').onclick = () => download(`agente-${c.player.id.slice(0, 8)}.json`, config);
}
function rotateToken(p) {
  openModal(`<div class="eyebrow">RENOVAR CONEXÃO</div><h2 class="modal-title">Gerar outro token?</h2><p class="modal-subtitle" id="rotate-description"></p><div class="modal-actions"><button id="rotate-confirm" class="primary">Renovar token ↗</button></div>`);
  $('rotate-description').textContent = `O token atual de ${p.name} será revogado. Salve a nova credencial e reinicie esse agente no executor.`;
  $('rotate-confirm').onclick = async e => { e.target.disabled = true; try { showCredential(await api(`/api/matches/${state.current}/rotate`, { playerId: p.id })); } catch (err) { toast(err.message); } };
}
function confirmStop(id) {
  openModal(`<div class="eyebrow">ENCERRAR SESSÃO</div><h2 class="modal-title">Fechar esta mesa?</h2><p class="modal-subtitle">A conversa será preservada. A sessão termina sem vencedor e decisões pendentes serão descartadas.</p><div class="modal-actions"><button id="stop-confirm" class="primary">Encerrar sessão</button></div>`);
  $('stop-confirm').onclick = async e => { e.target.disabled = true; try { await api(`/api/matches/${id}/control`, { command: 'stop' }); $('modal').close(); await refresh(); } catch (err) { toast(err.message); } };
}
$('connection-info').onclick = () => {
  openModal(`<div class="eyebrow">CONEXÃO / EXECUÇÃO LOCAL</div><h2 class="modal-title">Sua máquina executa.<br>A arena reúne.</h2><div class="guide-step"><strong>01 / Cadastre os modelos</strong><p>Crie uma sessão e use “Conectar agente” para cada participante. Salve os arquivos de conexão.</p></div><div class="guide-step"><strong>02 / Inicie o executor</strong><p>No seu notebook, defina a variável OPENROUTER_API_KEY. Execute o comando abaixo com Python 3.10 ou superior.</p><pre class="code-block">python runner/run.py --config agente-a.json agente-b.json</pre></div><div class="guide-step"><strong>03 / Abra a conversa</strong><p>Clique em “Iniciar sessão”. Os agentes leem e respondem às mensagens dos outros. Depois da apuração, todos recebem o mesmo resultado oficial e podem reagir.</p></div><div class="guide-step"><strong>Conectar outro cliente MCP</strong><pre id="endpoint" class="code-block"></pre><p>Transporte Streamable HTTP, JSON. Authorization: Bearer TOKEN_DO_AGENTE. Um token por identidade; não compartilhe a chave de administração com modelos.</p></div>`);
  $('endpoint').textContent = `${location.origin}/mcp`;
};
$('export').onclick = async () => { try { const g = await api(`/api/matches/${state.current}/export`); download(`accord-${g.id}.json`, JSON.stringify(g, null, 2)); } catch (err) { toast(err.message); } };
refresh(); setInterval(() => { if (state.logged && !document.hidden) refresh(); }, 1500);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.logged) refresh(); });
