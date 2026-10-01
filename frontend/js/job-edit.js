// Edit posting facts from any Inbox or Pipeline surface. Identity, stage and
// generated documents remain on the same tracked job.
function jobEditValues(job) {
    return {
        title: job.title || '', company: job.company || '', location: job.location || '',
        url: job.url || '', description: job.description || '',
        salary_min: job.salary_min ?? null, salary_max: job.salary_max ?? null,
        salary_period: job.salary_period || 'unknown',
        tags: safeParseJSON(job.tags, []), date_posted: job.date_posted ? job.date_posted.slice(0, 10) : null,
        is_remote: !!job.is_remote, is_easy_apply: !!job.is_easy_apply,
        apply_type: job.apply_type || 'unknown',
    };
}

async function editJobDetails(jobId) {
    if (document.getElementById('job-edit-overlay')) return;
    let job;
    try { job = await api(`/api/jobs/${encodeURIComponent(jobId)}`); }
    catch (e) { toast('Failed to load job details', 'error'); return; }
    if (document.getElementById('job-edit-overlay')) return;
    const original = jobEditValues(job);
    const returnToModal = typeof isJobModalOpen === 'function' && isJobModalOpen();
    const previousFocus = document.activeElement;
    if (typeof _closeCardMenu === 'function') _closeCardMenu();
    if (returnToModal) closeJobModal();

    const overlay = document.createElement('div');
    overlay.id = 'job-edit-overlay';
    overlay.className = 'app-dialog-overlay job-edit-overlay';
    const field = (key, label, type = 'text', attrs = '') => `
        <div class="form-group"><label for="job-edit-${key}">${label}</label>
        <input id="job-edit-${key}" name="${key}" type="${type}" value="${escapeHtml(original[key] ?? '')}" ${attrs}></div>`;
    const select = (key, label, options) => `
        <div class="form-group"><label for="job-edit-${key}">${label}</label>
        <select id="job-edit-${key}" name="${key}">${options.map(([value, text]) =>
            `<option value="${value}"${original[key] === value ? ' selected' : ''}>${text}</option>`).join('')}</select></div>`;
    overlay.innerHTML = `<div class="app-dialog job-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="job-edit-heading">
        <h2 id="job-edit-heading">Edit job</h2>
        <form id="job-edit-form">
            ${field('title', 'Job title', 'text', 'required maxlength="500"')}
            ${field('company', 'Company', 'text', 'maxlength="500"')}
            ${field('url', 'Job link', 'url', 'maxlength="8000"')}
            ${field('location', 'Location', 'text', 'maxlength="500"')}
            <div class="job-edit-pay">
                ${field('salary_min', 'Minimum pay', 'number', 'min="0" step="any"')}
                ${field('salary_max', 'Maximum pay', 'number', 'min="0" step="any"')}
                ${select('salary_period', 'Pay period', [['unknown', 'Unspecified'], ['annual', 'Annual'], ['hourly', 'Hourly']])}
            </div>
            ${field('date_posted', 'Posting date', 'date')}
            ${select('apply_type', 'Application type', [['unknown', 'Unspecified'], ['external', 'Employer site'], ['easy_apply', 'LinkedIn Easy Apply'], ['quick_apply', 'Indeed Quick Apply']])}
            <div class="form-group"><label for="job-edit-tags">Tags (one per line)</label>
                <textarea id="job-edit-tags" name="tags" rows="3">${escapeHtml(original.tags.join('\n'))}</textarea></div>
            <div class="form-group"><label for="job-edit-description">Description</label>
                <textarea id="job-edit-description" name="description" rows="8" maxlength="100000">${escapeHtml(original.description)}</textarea></div>
            <div class="job-edit-flags">
                <label><input name="is_remote" type="checkbox"${original.is_remote ? ' checked' : ''}> Remote role</label>
                <label><input name="is_easy_apply" type="checkbox"${original.is_easy_apply ? ' checked' : ''}> Easy Apply available</label>
            </div>
            <p class="hint">Changes update this tracked posting. Existing resumes and cover letters stay as saved.</p>
            <p id="job-edit-error" class="job-edit-error" role="alert"></p>
            <div class="app-dialog-buttons">
                <button type="button" class="btn btn-secondary" id="job-edit-cancel">Cancel</button>
                <button type="submit" class="btn btn-primary" id="job-edit-save">Save changes</button>
            </div>
        </form>
    </div>`;
    document.body.appendChild(overlay);
    const form = overlay.querySelector('form');
    const save = overlay.querySelector('#job-edit-save');
    const cancel = overlay.querySelector('#job-edit-cancel');
    let saving = false;
    const close = async () => {
        if (saving) return;
        overlay.remove();
        if (returnToModal) await openJobModal(jobId);
        else if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    };
    cancel.addEventListener('click', close);
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
    overlay.addEventListener('keydown', event => {
        // Keep the page's hotkeys and peek-modal Escape handler out of this form.
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
            const controls = [...overlay.querySelectorAll('input, textarea, select, button')].filter(el => !el.disabled);
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (saving || !form.reportValidity()) return;
        const value = key => form.elements.namedItem(key).value.trim();
        const current = {
            title: value('title'), company: value('company'), url: value('url'), location: value('location'),
            description: form.elements.namedItem('description').value,
            salary_min: value('salary_min') === '' ? null : Number(value('salary_min')),
            salary_max: value('salary_max') === '' ? null : Number(value('salary_max')),
            salary_period: value('salary_period'), date_posted: value('date_posted') || null,
            apply_type: value('apply_type'), tags: value('tags').split('\n').map(tag => tag.trim()).filter(Boolean),
            is_remote: form.elements.namedItem('is_remote').checked,
            is_easy_apply: form.elements.namedItem('is_easy_apply').checked,
        };
        const changes = Object.fromEntries(Object.entries(current).filter(([key, value]) =>
            JSON.stringify(value) !== JSON.stringify(original[key])));
        const error = overlay.querySelector('#job-edit-error');
        if (!current.title) { error.textContent = 'Enter a job title.'; return; }
        if (current.salary_min !== null && current.salary_max !== null && current.salary_min > current.salary_max) {
            error.textContent = 'Minimum pay cannot exceed maximum pay.'; return;
        }
        if (!Object.keys(changes).length) { await close(); return; }
        saving = true;
        save.disabled = cancel.disabled = true;
        save.textContent = 'Saving…';
        error.textContent = '';
        try {
            const updated = await api(`/api/jobs/${encodeURIComponent(jobId)}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
            });
            if (updated.application) {
                updated.app_status = updated.application.status;
                updated.app_id = updated.application.id;
            }
            window._currentJobs = window._currentJobs || {};
            window._currentJobs[jobId] = updated;
        } catch (e) {
            const details = safeParseJSON(e.message, null);
            error.textContent = (details && typeof details.detail === 'string' ? details.detail : null)
                || 'Could not save this job. Check the fields and try again.';
            saving = false;
            save.disabled = cancel.disabled = false;
            save.textContent = 'Save changes';
            return;
        }
        saving = false;
        await close();
        toast('Job details saved', 'success');
        // Reload the active surface so corrected company/title/link are visible.
        if (location.hash.replace('#', '') === 'review') {
            if (typeof isBoardModeActive === 'function' && isBoardModeActive()) await renderBoard();
            else switchReviewView(currentReviewView);
        } else if (typeof isInboxStageActive === 'function' && isInboxStageActive()) await loadStage();
        else await loadJobs();
    });
    form.elements.namedItem('title').focus();
}
