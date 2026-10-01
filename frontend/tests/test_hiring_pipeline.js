const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM(`<section id="review" class="view-board">
    <div id="pipeline-funnel"></div><div id="pipeline-board"></div>
    <div id="pipeline-filter-chip" hidden></div><div id="review-tab-bar"></div>
    <div id="review-submitted-view"><div id="submitted-list"></div></div>
    </section>`, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/#review' });
const w = dom.window;
const addListener = w.document.addEventListener.bind(w.document);
w.document.addEventListener = (type, ...args) => { if (type !== 'DOMContentLoaded') addListener(type, ...args); };
w.eval(['pipeline-stages.js', 'core.js', 'dashboard.js', 'job-actions.js', 'jobs.js', 'review.js', 'jobs-actions.js', 'deck.js']
    .map(file => fs.readFileSync(path.join(__dirname, '../js', file), 'utf8')).join('\n;\n'));
w.toast = () => {};
const apps = ['awaiting', 'no_response', 'screening', 'interview', 'offer', 'rejected', 'withdrawn'].map(outcome => ({
    id: `a-${outcome}`, job_id: `j-${outcome}`, title: outcome, company: 'Acme',
    outcome, status: 'applied', resume_content: 'Saved resume',
}));
const writes = [];
w.api = async (url, options) => {
    if (options && options.method === 'PATCH') {
        const changes = JSON.parse(options.body);
        writes.push({ url, changes });
        apps.find(app => url.includes(`/api/applications/${app.id}/`)).outcome = changes.outcome;
        return { ok: true };
    }
    const parsed = new URL(url, 'http://localhost');
    if (parsed.pathname === '/api/applications/submitted') {
        const stage = parsed.searchParams.get('stage');
        return apps.filter(app => !stage || w.pipelineStageForOutcome(app.outcome).key === stage).map(app => ({ ...app }));
    }
    if (parsed.pathname === '/api/jobs') return { jobs: [], total: 0 };
    if (parsed.pathname.endsWith('in-progress')) return { in_progress: [], needs_attention: [] };
    if (parsed.pathname.endsWith('/status')) return {};
    return [];
};

(async () => {
    await w.renderBoard();
    const doc = w.document;
    assert.deepEqual([...doc.querySelectorAll('.pipeline-primary > .kcol')].map(col => col.dataset.col),
        ['applied', 'interviewing', 'offer']);
    for (const group of ['preparation', 'issues', 'history']) {
        assert.equal(doc.querySelector(`details[data-group="${group}"]`).open, false);
    }
    assert.equal(doc.querySelectorAll('#kcards-applied .kcard').length, 2);
    assert.equal(doc.querySelectorAll('#kcards-interviewing .kcard').length, 2);
    assert.equal(doc.querySelectorAll('#kcards-offer .kcard').length, 1);
    assert.equal(doc.querySelectorAll('#kcards-closed .kcard').length, 2);
    assert.equal(doc.getElementById('kgroup-history').textContent, '2');
    const prep = doc.querySelector('details[data-group="preparation"]');
    prep.open = true;
    await w.renderBoard();
    assert.equal(prep, doc.querySelector('details[data-group="preparation"]'));
    assert.equal(prep.open, true, 'refresh preserves expanded groups');

    assert.equal(await w.runDeckDrop('applied', 'interviewing', 'a-awaiting'), true);
    assert.equal(writes[0].url, '/api/applications/a-awaiting/outcome');
    assert.deepEqual(writes[0].changes, { outcome: 'interview' });
    assert(doc.querySelector('#kcards-interviewing [data-id="a-awaiting"]'));
    assert.equal(await w.runDeckDrop('interviewing', 'offer', 'a-awaiting'), true);
    assert(doc.querySelector('#kcards-offer [data-id="a-awaiting"]'));
    assert.equal(await w.runDeckDrop('offer', 'applied', 'a-awaiting'), true);
    assert(doc.querySelector('#kcards-applied [data-id="a-awaiting"]'));
    assert(writes.every(write => !('status' in write.changes)), 'hiring moves never overwrite submission status');
    await w._runCardOutcome('a-awaiting', 'rejected');
    assert(doc.querySelector('#kcards-closed [data-id="a-awaiting"]'));
    assert.equal(doc.getElementById('kgroup-history').textContent, '3');
    w.setBoardFilter('needs-attention', 'failed');
    assert.equal(doc.querySelector('details[data-group="issues"]').open, true);

    w._currentJobs['j-offer'] = { id: 'j-offer', app_status: 'applied', app_outcome: 'offer' };
    w.viewApplicationFor('j-offer');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(doc.getElementById('review-submitted-view').style.display, '');
    assert.equal(doc.getElementById('review-tab-offer').classList.contains('active'), true);
    assert.equal(doc.querySelectorAll('#submitted-list .review-card').length, 1);
    assert.equal(doc.querySelector('#submitted-list .review-card-title').textContent, 'offer');
    console.log('PASS hiring pipeline layout, grouping, moves, closed history, and table stages');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => dom.window.close());
