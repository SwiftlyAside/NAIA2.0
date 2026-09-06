// Agent Inbox 패널 — 인박스(배치 카드) ↔ 보드(잡 카드 그리드) 한 패널 안 전환.
// 상태는 서버 방송(agent_inbox_state)이 정본이고, 여기서는 그리기만 한다.
import { progressOf, jobStatusLabel, verdictClass, reviewChips, costLine, isFreeTierJob } from './agentInboxModel.mjs';

export function createAgentInboxPanel({
  document, window, fetch: fetchFn, localStorage, send, showToast = () => {}, escHtml = v => String(v ?? ''),
  showAppDialog, onUnread = () => {}, openHistory = () => {},
}) {
  const root = document.getElementById('agentInboxPanel');
  if (!root) return { init() {}, handleState() {}, handleNew() {}, handleDone() {}, handleVerdictsDone() {}, onAnlas() {}, open() {}, toggle() {} };
  const title = root.querySelector('[data-ai-title]');
  const meta = root.querySelector('[data-ai-meta]');
  const body = root.querySelector('[data-ai-body]');
  const backBtn = root.querySelector('[data-ai-action="back"]');
  const collapseBtn = root.querySelector('[data-ai-collapse]');
  const closeBtn = root.querySelector('[data-ai-action="close"]');
  const STORAGE_KEY = 'naia_agent_inbox_collapsed';
  let state = { batches: [], active: null, unread: 0 };
  let view = 'inbox';            // 'inbox' | 'board'
  let boardBatch = null;         // 보드에 펼친 배치(전체)
  const expanded = new Set();    // 인박스에서 펼친 batch_id
  const excluded = new Set();    // 승인 전 개별 제외한 job_id
  let anlas = null;
  let collapsed = localStorage.getItem(STORAGE_KEY) === '1';
  let visible = false;

  async function fetchBatch(batchId) {
    const r = await fetchFn(`/api/agent-inbox/batches/${encodeURIComponent(batchId)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function badge(text, cls = '') { return `<span class="ai-badge ${cls}">${escHtml(text)}</span>`; }

  function batchStatusLabel(status) {
    return { pending: '승인 대기', approved: '승인됨', generating: '생성 중', done: '완료', cancelled: '취소', rejected: '거절' }[status] || status;
  }

  function renderInbox() {
    // 거절·결과 없는 취소 배치는 인박스에서 숨긴다(결과가 있는 취소 배치는 보드로 볼 수 있게 남긴다).
    const rows = state.batches.filter(b => b.status !== 'rejected' && !(b.status === 'cancelled' && !(b.counts?.done)));
    if (!rows.length) { body.innerHTML = '<div class="ai-empty">받은 배치가 없습니다</div>'; return; }
    body.innerHTML = rows.map(b => {
      const isOpen = expanded.has(b.batch_id);
      const paid = b.paid_jobs ? badge(`${b.paid_jobs} 과금`, 'warn') : '';
      // 완료 배치의 판정 진행 — 남은 수(경고색) 또는 "판정 완료"(에이전트 회수 대기)
      const verdictChip = b.status === 'done'
        ? (b.verdicts_done ? badge('판정 완료', 'done') : (b.verdicts_pending ? badge(`판정 ${b.verdicts_pending} 남음`, 'warn') : ''))
        : '';
      const actions = b.status === 'pending'
        ? `<button type="button" class="ai-btn primary" data-ai-approve="${escHtml(b.batch_id)}">생성 시작</button>
           <button type="button" class="ai-btn danger" data-ai-reject="${escHtml(b.batch_id)}">거절</button>`
        : `<button type="button" class="ai-btn" data-ai-open="${escHtml(b.batch_id)}">보드</button>`;
      return `<div class="ai-batch ${b.status}" data-batch="${escHtml(b.batch_id)}">
        <div class="ai-batch-top">
          <span class="ai-batch-title">${escHtml(b.title)}</span>
          ${badge(b.source)} ${badge(`${b.job_count}장`)} ${badge(batchStatusLabel(b.status), b.status)} ${paid} ${verdictChip}
        </div>
        <div class="ai-batch-sub">${escHtml(b.project || '')} · ${escHtml((b.created_at || '').replace('T', ' '))}</div>
        <div class="ai-batch-actions">${actions}
          <button type="button" class="ai-btn ghost" data-ai-expand="${escHtml(b.batch_id)}">${isOpen ? '접기' : '펼치기'}</button></div>
        ${isOpen ? `<div class="ai-batch-jobs" data-ai-jobs="${escHtml(b.batch_id)}">불러오는 중…</div>` : ''}
      </div>`;
    }).join('');
    for (const id of expanded) loadJobRows(id);
  }

  async function loadJobRows(batchId) {
    const holder = body.querySelector(`[data-ai-jobs="${CSS.escape(batchId)}"]`);
    if (!holder) return;
    try {
      const b = await fetchBatch(batchId);
      holder.innerHTML = b.jobs.map(j => `<label class="ai-job-row ${j.status}">
        <input type="checkbox" data-ai-include="${escHtml(j.job_id)}" ${excluded.has(j.job_id) || j.status !== 'pending' ? '' : 'checked'} ${j.status !== 'pending' ? 'disabled' : ''}>
        <span class="ai-job-key">${escHtml(j.key)}</span>
        <span class="ai-job-expect">${escHtml([j.expect?.character, j.expect?.emotion, j.expect?.label].filter(Boolean).join(' · '))}</span>
        ${isFreeTierJob(j.params) ? '' : badge('과금', 'warn')}
        <span class="ai-job-prompt">${escHtml(j.prompt)}</span>
      </label>`).join('');
    } catch (e) { holder.textContent = `불러오기 실패: ${e.message}`; }
  }

  function renderBoard() {
    const b = boardBatch;
    if (!b) { view = 'inbox'; renderInbox(); return; }
    const p = progressOf(b);
    body.innerHTML = `<div class="ai-board-head">
        <span class="ai-board-title">${escHtml(b.title)}</span>
        <span class="ai-board-progress">${p.finished}/${p.total}${p.generating ? ' · 생성 중' : ''}</span>
        ${['approved', 'generating'].includes(b.status) ? `<button type="button" class="ai-btn danger" data-ai-cancel="${escHtml(b.batch_id)}">취소</button>` : ''}
      </div>
      <div class="ai-grid">${b.jobs.map(renderJobCard).join('')}</div>`;
  }

  function renderJobCard(j) {
    const thumb = j.history_id
      ? `<img class="ai-thumb" src="/api/history/thumb/${encodeURIComponent(j.history_id)}" alt="${escHtml(j.key)}" data-ai-thumb="${escHtml(j.rel_path || '')}" data-ai-image="/api/history/image/${encodeURIComponent(j.history_id)}">`
      : `<div class="ai-thumb ai-thumb-empty ${j.status}">${escHtml(jobStatusLabel(j.status))}</div>`;
    const chips = reviewChips(j).map(c => `<span class="ai-chip ${c.value}" title="${escHtml(j.agent_review?.note || '')}">${escHtml(c.label)}</span>`).join('');
    const v = j.verdict?.decision || '';
    const canJudge = j.status === 'done';
    return `<div class="ai-card ${j.status} ${verdictClass(j)}" data-job="${escHtml(j.job_id)}" tabindex="0">
      ${thumb}
      <div class="ai-card-meta">
        <span class="ai-job-key">${escHtml(j.key)}</span>
        <span class="ai-expect">${escHtml([j.expect?.character, j.expect?.emotion].filter(Boolean).join(' · '))}</span>
        ${badge(jobStatusLabel(j.status), j.status)}
      </div>
      ${j.error ? `<div class="ai-error">${escHtml(j.error)}</div>` : ''}
      <div class="ai-chips">${chips}</div>
      <div class="ai-verdict">
        <button type="button" class="ai-btn sm ${v === 'accept' ? 'on' : ''}" data-ai-verdict="accept" ${canJudge ? '' : 'disabled'}>채택</button>
        <button type="button" class="ai-btn sm ${v === 'reject' ? 'on' : ''}" data-ai-verdict="reject" ${canJudge ? '' : 'disabled'}>반려</button>
        <button type="button" class="ai-btn sm ${v === 'redo' ? 'on' : ''}" data-ai-verdict="redo" ${canJudge ? '' : 'disabled'}>재발주</button>
        <input type="text" class="ai-note" placeholder="메모" value="${escHtml(j.verdict?.note || '')}" data-ai-note ${canJudge ? '' : 'disabled'}>
      </div>
    </div>`;
  }

  function render() {
    root.hidden = !visible;
    root.classList.toggle('collapsed', collapsed);
    if (title) title.textContent = view === 'board' ? 'Agent Inbox · 보드' : 'Agent Inbox';
    if (meta) meta.textContent = state.unread ? `${state.unread} 대기` : '';
    if (backBtn) backBtn.hidden = view !== 'board';
    if (collapseBtn) collapseBtn.textContent = collapsed ? '▴' : '▾';
    if (collapsed) { body.innerHTML = ''; return; }
    if (view === 'board') renderBoard(); else renderInbox();
  }

  async function approve(batchId) {
    let batch;
    try { batch = await fetchBatch(batchId); } catch (e) { showToast(`배치를 읽지 못했습니다: ${e.message}`, 'error'); return; }
    const jobIds = batch.jobs.filter(j => j.status === 'pending' && !excluded.has(j.job_id)).map(j => j.job_id);
    if (!jobIds.length) { showToast('승인할 잡이 없습니다', 'warning'); return; }
    const line = costLine({ jobs: batch.jobs.filter(j => jobIds.includes(j.job_id)) }, anlas);
    const ok = showAppDialog
      ? await showAppDialog('', { title: '생성 시작', messageHtml: escHtml(line), okText: '생성', cancelText: '취소' })
      : window.confirm(line);
    if (!ok) return;
    send({ type: 'agent_inbox_approve', batch_id: batchId, job_ids: jobIds });
    boardBatch = batch; view = 'board'; render();
  }

  function bind() {
    body.addEventListener('click', async event => {
      const t = event.target.closest('[data-ai-approve],[data-ai-reject],[data-ai-open],[data-ai-expand],[data-ai-cancel],[data-ai-verdict],[data-ai-thumb]');
      if (!t) return;
      event.preventDefault();
      if (t.dataset.aiApprove) return approve(t.dataset.aiApprove);
      if (t.dataset.aiReject) { send({ type: 'agent_inbox_reject', batch_id: t.dataset.aiReject }); return; }
      if (t.dataset.aiExpand) { const id = t.dataset.aiExpand; if (expanded.has(id)) expanded.delete(id); else expanded.add(id); render(); return; }
      if (t.dataset.aiOpen) { try { boardBatch = await fetchBatch(t.dataset.aiOpen); view = 'board'; render(); } catch (e) { showToast(e.message, 'error'); } return; }
      if (t.dataset.aiCancel) { send({ type: 'agent_inbox_cancel', batch_id: t.dataset.aiCancel }); return; }
      if (t.dataset.aiVerdict) {
        const card = t.closest('[data-job]');
        const note = card?.querySelector('[data-ai-note]')?.value || '';
        send({ type: 'agent_inbox_verdict', job_id: card.dataset.job, decision: t.dataset.aiVerdict, note });
        return;
      }
      if (t.dataset.aiThumb !== undefined) openHistory(t.dataset.aiThumb, t.dataset.aiImage);
    });
    body.addEventListener('change', event => {
      const cb = event.target.closest('[data-ai-include]');
      if (!cb) return;
      const id = cb.dataset.aiInclude;
      if (cb.checked) excluded.delete(id); else excluded.add(id);
    });
    body.addEventListener('keydown', event => {
      const card = event.target.closest('[data-job]');
      if (!card || event.target.matches('input')) return;
      const map = { 1: 'accept', 2: 'reject', 3: 'redo' };
      if (!map[event.key]) return;
      event.preventDefault();
      const note = card.querySelector('[data-ai-note]')?.value || '';
      send({ type: 'agent_inbox_verdict', job_id: card.dataset.job, decision: map[event.key], note });
    });
    backBtn?.addEventListener('click', e => { e.preventDefault(); view = 'inbox'; render(); });
    closeBtn?.addEventListener('click', e => { e.preventDefault(); visible = false; render(); });
    collapseBtn?.addEventListener('click', e => { e.preventDefault(); collapsed = !collapsed; localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); render(); });
  }

  function handleState(next) {
    state = { batches: Array.isArray(next?.batches) ? next.batches : [], active: next?.active || null, unread: Number(next?.unread || 0) };
    if (view === 'board' && boardBatch && state.active && state.active.batch_id === boardBatch.batch_id) boardBatch = state.active;
    else if (view === 'board' && boardBatch) fetchBatch(boardBatch.batch_id).then(b => { boardBatch = b; render(); }).catch(() => {});
    onUnread(state.unread);
    render();
  }
  function handleNew(m) { visible = true; collapsed = false; view = 'inbox'; render(); showToast(`Agent Inbox: ${m.title || ''} (${m.job_count}장)`, 'info'); }
  function handleDone(m) { showToast(`Agent Inbox 완료: ${m.done} 성공 · ${m.failed} 실패 · ${m.skipped} 제외`, m.failed ? 'warning' : 'success'); }
  function handleVerdictsDone(m) { showToast(`판정 완료: 채택 ${m.accept} · 반려 ${m.reject} · 재발주 ${m.redo} — 에이전트가 회수합니다`, 'success'); }
  function onAnlas(m) { anlas = m; }
  function open() { visible = true; collapsed = false; render(); send({ type: 'agent_inbox_refresh' }); }
  function toggle() { if (visible) { visible = false; render(); } else { open(); } }
  function init() { bind(); render(); }
  return { init, handleState, handleNew, handleDone, handleVerdictsDone, onAnlas, open, toggle };
}
