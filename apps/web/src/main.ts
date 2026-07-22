import { LocalApiClient } from './api.ts';
import { allocateCheck, bootstrapFromFragment, escapeHtml, resultView, validateDraftForSave, type DraftProblemView, type UploadMetadata } from './workflow.ts';

const api = new LocalApiClient();
let artifact: UploadMetadata | undefined;
let draft: readonly DraftProblemView[] = [];

function render(message = ''): void {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) return;
  root.innerHTML = `<main>
    <h1>Excel/Access 채점</h1>
    <p id="message">${escapeHtml(message)}</p>
    <form id="upload-form"><label>답안 파일 <input name="file" type="file" required></label><button>업로드</button></form>
    <section id="draft">${artifact ? `<p>업로드됨: ${escapeHtml(artifact.detectedFormat)} (${artifact.size} bytes)</p>` : ''}${draft.map((problem) => `<article><h2>${escapeHtml(problem.id)} (${problem.maxScore}점)</h2>${problem.checks.map((check) => `<label><input class="check" data-check-id="${escapeHtml(check.id)}" type="checkbox" ${check.enabled ? 'checked' : ''}> ${escapeHtml(check.id)} <input class="points" data-check-id="${escapeHtml(check.id)}" type="number" min="0" step="1" value="${check.points}">점</label>`).join('<br>')}</article>`).join('')}</section>
    <button id="save" ${artifact ? '' : 'disabled'}>규칙 저장</button>
    <button id="grade-full" ${artifact ? '' : 'disabled'}>전체 채점</button>
    <button id="grade-selected" ${artifact ? '' : 'disabled'}>선택 채점</button>
    <section id="result" aria-live="polite"></section>
  </main>`;
  root.querySelector<HTMLFormElement>('#upload-form')?.addEventListener('submit', (event) => void upload(event));
  root.querySelector<HTMLButtonElement>('#save')?.addEventListener('click', () => void save());
  root.querySelector<HTMLButtonElement>('#grade-full')?.addEventListener('click', () => void grade());
  root.querySelector<HTMLButtonElement>('#grade-selected')?.addEventListener('click', () => void grade(selectedProblemIds()));
  root.querySelectorAll<HTMLInputElement>('.check, .points').forEach((input) => input.addEventListener('change', updateAllocation));
}

function updateAllocation(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const checkId = input.dataset.checkId;
  if (!checkId) return;
  const check = draft.flatMap((problem) => problem.checks).find((candidate) => candidate.id === checkId);
  if (!check) return;
  const enabled = input.classList.contains('check') ? input.checked : check.enabled;
  const pointsInput = document.querySelector<HTMLInputElement>(`.points[data-check-id="${CSS.escape(checkId)}"]`);
  const points = input.classList.contains('points') ? Number(input.value) : Number(pointsInput?.value ?? check.points);
  draft = allocateCheck(draft, checkId, enabled, points);
}
function selectedProblemIds(): string[] {
  return draft.filter((problem) => problem.checks.some((check) => check.enabled)).map((problem) => problem.id);
}

async function upload(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const file = new FormData(event.currentTarget as HTMLFormElement).get('file');
  if (!(file instanceof File)) return render('파일을 선택하세요.');
  try {
    artifact = await api.upload(file);
    draft = await api.loadDraft(artifact.id);
    render('초안 규칙을 배점하여 저장하세요.');
  } catch {
    render('업로드 또는 초안 불러오기에 실패했습니다.');
  }
}

async function save(): Promise<void> {
  if (!artifact) return;
  try {
    validateDraftForSave(draft);
    await api.saveDraft(artifact.id, draft);
    render('규칙이 저장되었습니다.');
  } catch (error) {
    render(error instanceof Error ? error.message : '규칙 저장에 실패했습니다.');
  }
}

async function grade(problemIds?: readonly string[]): Promise<void> {
  if (!artifact) return;
  try {
    validateDraftForSave(draft);
    const response = await api.grade({ artifactId: artifact.id, ...(problemIds === undefined ? {} : { problemIds }) });
    const view = resultView(response.summary);
    const result = document.querySelector('#result');
    if (result) result.innerHTML = `<h2>${escapeHtml(view.scope)}</h2><p>${escapeHtml(view.score)}</p><p>${escapeHtml(view.message)}</p>`;
  } catch (error) {
    render(error instanceof Error ? error.message : '채점에 실패했습니다.');
  }
}

void bootstrapFromFragment(window.location, window.history, (token) => api.bootstrap(token)).then(
  () => render(),
  () => render('인증 초기화에 실패했습니다.'),
);
