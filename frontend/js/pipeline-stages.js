// Jobsmith frontend — the ONE Pipeline stage vocabulary.
//
// Phase 2 of the UI consolidation: the funnel strip, the kanban column heads,
// the classic stage tabs, the drag/menu move labels and the board legend all
// used to carry their own copies of these strings (and drifted). They now all
// render from PIPELINE_STAGES.
//
// Loaded before review.js and deck.js (classic script, shared global scope).
// The list is ordered by how work actually flows:
//   Applied → Interviewing → Offer. Preparation, submission issues and
//   closed history stay available in separate expandable sections.
//
// Each stage carries:
//   key    canonical id, also the key in the shared count store
//   label  the single user-facing string for that stage
//   desc   one-line meaning (funnel tooltips; wording from the tour copy)
//   funnel true → gets a segment in the funnel strip
//   board  true → gets a column on the kanban board
//   col    the board column this stage lives in (Failed and In Progress both
//          land in Needs Attention — the board is coarser than the funnel)
//   tab    the classic stage-table view name (currentReviewView value), if any
//   dot    column dot colour   seg  funnel segment colour class
const PIPELINE_STAGES = [
    {
        key: 'applied', label: 'Applied',
        desc: 'Submitted applications waiting for an employer response.',
        outcomes: ['awaiting', 'no_response'], group: 'primary',
        funnel: true, board: true, col: 'applied', tab: 'submitted',
        dot: 'var(--steel)', seg: 'fseg-steel',
    },
    {
        key: 'interviewing', label: 'Interviewing',
        desc: 'Applications in screening or interviews with the employer.',
        outcomes: ['screening', 'interview'], group: 'primary',
        funnel: true, board: true, col: 'interviewing', tab: 'interviewing',
        dot: 'var(--accent-yellow)', seg: 'fseg-amber',
    },
    {
        key: 'offer', label: 'Offer',
        desc: 'Applications for which the employer has made an offer.',
        outcomes: ['offer'], group: 'primary',
        funnel: true, board: true, col: 'offer', tab: 'offer',
        dot: 'var(--accent-green)', seg: 'fseg-green',
    },
    {
        key: 'shortlisted', label: 'Shortlisted', group: 'preparation',
        desc: 'Jobs you kept while scouting the Inbox — no application exists yet.',
        funnel: false, board: true, col: 'shortlisted', tab: 'shortlisted',
        dot: 'var(--steel)', seg: 'fseg-steel',
    },
    {
        key: 'tailoring', label: 'Tailoring', group: 'preparation',
        desc: 'The AI is writing the résumé and cover letter for these.',
        funnel: false, board: true, col: 'tailoring', tab: null,
        dot: 'var(--accent-yellow)', seg: 'fseg-amber',
    },
    {
        key: 'pending', label: 'Ready to Review', group: 'preparation',
        desc: 'Tailored applications waiting for your approval before they go out.',
        funnel: false, board: true, col: 'pending', tab: 'pending',
        dot: 'var(--accent-ember)', seg: 'fseg-ember',
    },
    {
        key: 'failed', label: 'Failed', group: 'issues',
        desc: 'Submissions that errored out — retry them or apply manually.',
        funnel: false, board: false, col: 'needs-attention', tab: 'failed',
        dot: 'var(--accent-red)', seg: 'fseg-red',
    },
    {
        key: 'in-progress', label: 'In Progress', group: 'issues',
        desc: 'Submissions still mid-flight, plus anything that stopped and needs you.',
        funnel: false, board: false, col: 'needs-attention', tab: 'in-progress',
        dot: 'var(--accent-yellow)', seg: 'fseg-amber',
    },
    {
        key: 'needs-attention', label: 'Submission Issues', group: 'issues',
        desc: 'Failed or stalled submissions that need a decision from you.',
        funnel: false, board: true, col: 'needs-attention', tab: null,
        dot: 'var(--accent-red)', seg: 'fseg-red',
    },
    {
        key: 'closed', label: 'Closed applications', group: 'history',
        desc: 'Rejected and withdrawn applications kept for reference.',
        outcomes: ['rejected', 'withdrawn'],
        funnel: false, board: true, col: 'closed', tab: 'closed',
        dot: 'var(--text-muted)', seg: 'fseg-steel',
    },
];

// Exposed as functions so the top-level `const` (lexical, and one eval unit in
// the jsdom tests) is reachable as a global everywhere.
function pipelineStages() { return PIPELINE_STAGES; }
function funnelStages() { return PIPELINE_STAGES.filter((s) => s.funnel); }
function boardStages() { return PIPELINE_STAGES.filter((s) => s.board); }
function stageByKey(key) { return PIPELINE_STAGES.find((s) => s.key === key) || null; }
function stageByTab(tab) { return PIPELINE_STAGES.find((s) => s.tab === tab) || null; }

// Label lookup for anything that speaks in stage keys (board columns, the drag
// map's `to` values). 'pass' is a verdict, not a stage, but the move menu and
// the board legend need a word for it.
function stageLabel(key) {
    if (key === 'pass') return 'Pass';
    const s = stageByKey(key);
    return s ? s.label : String(key);
}

// Count-store key for a classic tab name ('submitted' → 'applied').
function stageKeyForTab(tab) {
    const s = stageByTab(tab);
    return s ? s.key : tab;
}

// Existing backend outcomes and event history are the source of hiring progress.
function pipelineStageForOutcome(outcome) {
    return PIPELINE_STAGES.find(stage => stage.outcomes && stage.outcomes.includes(outcome || 'awaiting')) || stageByKey('applied');
}
