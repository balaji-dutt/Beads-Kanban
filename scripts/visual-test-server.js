#!/usr/bin/env node

/**
 * Standalone Visual Test Server for Beads Kanban
 *
 * Serves the Kanban board webview in a regular Chrome browser for visual testing
 * with Chrome DevTools MCP. Unlike the VS Code-based visual-test-harness.js,
 * this bypasses Electron entirely and runs in stock Chrome.
 *
 * Usage:
 *   node scripts/visual-test-server.js [--port=3333] [--debug-port=9222] [--no-chrome] [--theme=dark|light]
 *
 * Options:
 *   --port=NNNN        HTTP server port (default: 3333)
 *   --debug-port=NNNN  Chrome remote debugging port (default: 9222)
 *   --no-chrome         Don't auto-launch Chrome (just start the HTTP server)
 *   --theme=dark|light  VS Code color theme to simulate (default: dark)
 *   --rebuild           Force rebuild webview bundle before serving
 *   --dataset=test|showcase
 *                       test (default) keeps the adversarial title fixtures;
 *                       showcase replaces them for screenshots
 *
 * How it works:
 *   1. Optionally rebuilds the webview bundle (npm run build-webview)
 *   2. Generates standalone HTML that mirrors the VS Code webview
 *   3. Injects a mock acquireVsCodeApi() that responds with mock board data
 *   4. Serves on http://localhost:<port>
 *   5. Launches Chrome with --remote-debugging-port for CDP access
 *
 * Routes:
 *   /           -> Standalone HTML with mock VS Code API + board.js
 *   /media/*    -> Static files from media/ directory
 *   /out/*      -> Bundled files from out/ directory
 *
 * Prerequisites:
 *   npm run build-webview  (or use --rebuild flag)
 *
 * Note: This script uses child_process.spawn (not exec) to launch Chrome.
 * All arguments are passed as array elements, not interpolated into a shell
 * string, so there is no command-injection risk. The only use of execFileSync
 * is for the hardcoded "npm run build-webview" command.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const childProcess = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Shared filter markup
// ---------------------------------------------------------------------------

/**
 * Load src/filterMarkup.ts so the served page builds its filter dropdowns and
 * dialog selects from the same source as src/webview.ts.
 *
 * This script is plain CommonJS with no build step, so it transpiles the module
 * in-process rather than importing it. Requiring out/filterMarkup.js instead
 * would work only after `tsc -p .`; `npm run compile` uses esbuild and never
 * emits it, so the server would break for anyone who only ran compile.
 */
function loadFilterMarkup() {
  const esbuild = require('esbuild');
  const built = esbuild.buildSync({
    entryPoints: [path.join(PROJECT_ROOT, 'src', 'filterMarkup.ts')],
    bundle: true,
    format: 'cjs',
    write: false,
    platform: 'node',
    logLevel: 'silent'
  });
  const mod = { exports: {} };
  new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
  return mod.exports;
}

const filterMarkup = loadFilterMarkup();

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const cliArgs = process.argv.slice(2);

function getArg(name, defaultVal) {
  const prefix = '--' + name + '=';
  const found = cliArgs.find(function(a) { return a.startsWith(prefix); });
  if (found) { return found.slice(prefix.length); }
  return defaultVal;
}
function hasFlag(name) { return cliArgs.includes('--' + name); }

const HTTP_PORT = parseInt(getArg('port', '3333'), 10);
const DEBUG_PORT = parseInt(getArg('debug-port', '9222'), 10);
const NO_CHROME = hasFlag('no-chrome');
const THEME = getArg('theme', 'dark');
const REBUILD = hasFlag('rebuild');
const DATASET = getArg('dataset', 'test');

// ---------------------------------------------------------------------------
// Mock Board Data
// ---------------------------------------------------------------------------

/**
 * Generate realistic mock board data matching the EnrichedCard interface.
 * The board.js webview expects a board.minimal response with an array of
 * EnrichedCard objects that get distributed into columns by columnForCard().
 */
function generateMockBoardData() {
  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const lastWeek = new Date(Date.now() - 7 * 86400000).toISOString();
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();

  return [
    // --- Ready column (status=open, is_ready=true, blocked_by_count=0) ---
    {
      id: 'mock-000001',
      title: 'Implement user authentication flow',
      // Long-form fixture: a description sized to overflow the textarea and
      // to give the markdown preview enough to render.
      description: [
        'Replace the hand-rolled session login with OAuth2 against Google and GitHub. The current flow stores',
        'a bcrypt hash per user and issues an opaque session cookie, which works but puts us on the hook for',
        'password reset, breach monitoring and the support load that comes with both.',
        '',
        '### What users see',
        '',
        'Two provider buttons on the login page and nothing else. Existing password accounts keep working',
        'through a grace period: on first OAuth login with an email that matches an existing account, we link',
        'the two rather than creating a duplicate, and the password stops being accepted once the link is made.',
        '',
        'The linking step is the part most likely to go wrong. Matching on email alone means anyone who can',
        'get a provider to assert an address can claim the matching account, so we only auto-link when the',
        'provider marks the address verified, and fall back to an emailed confirmation when it does not.',
        '',
        '### What changes underneath',
        '',
        '- A `provider_identities` table keyed on (provider, subject), with a nullable link to `users`',
        '- The session cookie stays opaque; we are not moving to JWTs as part of this',
        '- `users.password_hash` becomes nullable and is cleared when an account finishes linking',
        '- The admin tool grows a "sign-in methods" panel so support can see how an account authenticates',
        '',
        '### Out of scope',
        '',
        'SAML, SCIM provisioning and org-level enforcement of a single provider. All three are on the',
        'enterprise roadmap and all three assume this lands first.'
      ].join('\n'),
      notes: [
        'Provider quirks worth remembering while implementing:',
        '',
        'GitHub does not return an email in the token response when the user has set their address to private.',
        'A second call to /user/emails is needed, and it can come back with no verified address at all, which',
        'is the case that has to route to the emailed-confirmation path rather than erroring.',
        '',
        'Google rotates its signing keys without notice, so the JWKS fetch cannot be cached indefinitely.',
        'Cache on the key id and refetch on an unknown one, with a rate limit so an attacker cannot use',
        'unknown key ids to drive unbounded outbound requests.',
        '',
        'Both providers return the subject as a string. It is numeric for GitHub today, but storing it as an',
        'integer would break the moment they widen it, and GitHub has said they will.'
      ].join('\n'),
      status: 'open',
      priority: 1,
      issue_type: 'feature',
      created_at: lastWeek,
      created_by: 'alice',
      updated_at: yesterday,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 2,
      assignee: 'alice',
      estimated_minutes: 480,
      labels: ['auth', 'backend', 'security'],
      external_ref: 'PROJ-101',
      pinned: true,
      blocked_by_count: 0,
      is_ready: true,
      children: [
        { id: 'mock-000002', title: 'This is an extremely long title that tests how the card layout handles overflow when a user enters a very verbose and detailed issue title that goes well beyond what would normally fit in the card width' },
        { id: 'mock-000005', title: 'Update API documentation' }
      ]
    },
    {
      id: 'mock-000002',
      title: 'This is an extremely long title that tests how the card layout handles overflow when a user enters a very verbose and detailed issue title that goes well beyond what would normally fit in the card width',
      description: 'Testing long title rendering',
      status: 'open',
      priority: 2,
      issue_type: 'task',
      created_at: twoWeeksAgo,
      created_by: 'bob',
      updated_at: lastWeek,
      closed_at: null,
      close_reason: null,
      dependency_count: 1,
      dependent_count: 0,
      assignee: 'bob',
      estimated_minutes: 120,
      labels: ['ui'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: true
    },
    {
      id: 'mock-000003',
      title: 'Fix <script>alert("XSS")</script> & "special" chars: \' < > & entities',
      description: 'Test card with special characters and potential XSS vectors in title',
      status: 'open',
      priority: 0,
      issue_type: 'bug',
      created_at: yesterday,
      created_by: 'charlie',
      updated_at: now,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 0,
      assignee: 'charlie',
      estimated_minutes: 30,
      labels: ['security', 'bug', 'P0'],
      external_ref: 'PROJ-999',
      pinned: false,
      blocked_by_count: 0,
      is_ready: true
    },
    {
      id: 'mock-000004',
      title: 'Add CSV export functionality',
      description: 'Export board data as CSV for reporting',
      status: 'open',
      priority: 3,
      issue_type: 'feature',
      created_at: twoWeeksAgo,
      created_by: 'diana',
      updated_at: twoWeeksAgo,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 0,
      assignee: null,
      estimated_minutes: null,
      labels: [],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: true
    },
    {
      id: 'mock-000005',
      title: 'Update API documentation',
      description: 'Refresh OpenAPI spec with new endpoints',
      status: 'open',
      priority: 2,
      issue_type: 'chore',
      created_at: lastWeek,
      created_by: 'eve',
      updated_at: yesterday,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 1,
      assignee: 'eve',
      estimated_minutes: 240,
      labels: ['docs', 'api'],
      external_ref: 'PROJ-205',
      pinned: false,
      blocked_by_count: 0,
      is_ready: true,
      blocks: [
        { id: 'mock-000010', title: 'Deploy to production' }
      ]
    },

    // --- In Progress column (status=in_progress) ---
    {
      id: 'mock-000006',
      title: 'Refactor database connection pooling',
      description: 'Switch from single connection to connection pool for better concurrency',
      status: 'in_progress',
      priority: 1,
      issue_type: 'task',
      created_at: twoWeeksAgo,
      created_by: 'alice',
      updated_at: now,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 3,
      assignee: 'alice',
      estimated_minutes: 360,
      labels: ['backend', 'performance', 'database'],
      external_ref: 'PROJ-150',
      pinned: false,
      blocked_by_count: 0,
      is_ready: false,
      // Long-form fixture: acceptance criteria and design notes sized to
      // overflow the inner form and the markdown preview.
      acceptance_criteria: [
        '- [ ] Pool size is configurable per environment, defaulting to 10 for the API and 4 for the worker fleet',
        '- [ ] Checkout blocks with a timeout rather than allocating a new connection when the pool is saturated',
        '- [ ] The timeout is configurable and defaults to 5s; a timed-out checkout raises a distinct error type so the retry layer can tell it apart from a query failure',
        '- [ ] Connections are validated before handout and discarded if the server closed them, so a failover does not surface as a burst of "server has gone away" errors',
        '- [ ] Idle connections are reaped after 10 minutes to stay under the managed instance connection cap',
        '- [ ] Pool checkout wait time, in-use count and idle count are exported as metrics',
        '- [ ] Load test at 3x current peak shows no connection errors and p99 checkout wait under 20ms',
        '- [ ] Rollback is a config flag, not a deploy: setting pool size to 1 reproduces the old single-connection behaviour'
      ].join('\n'),
      design: [
        '## Why',
        '',
        'Every request currently opens its own connection and closes it on the way out. That was fine when',
        'the service handled a few requests a second, but connection setup is now a measurable share of p99',
        'latency, and the managed instance has a hard cap of 200 connections that we hit during the Tuesday',
        'batch window. When we hit it, the failure is not graceful: new connections are refused and the',
        'health check fails, so the instance is pulled from the load balancer while it is otherwise healthy.',
        '',
        '## Approach',
        '',
        'Introduce a pool in front of the driver rather than changing call sites. The repository layer already',
        'goes through a single `getConnection()` helper, so the pool can be dropped in there and the ~200 call',
        'sites stay untouched. This keeps the diff reviewable and means a rollback is a config change.',
        '',
        'Sizing: pool size times instance count must stay under the 200 cap with headroom for migrations and',
        'ad-hoc sessions. At 12 API instances a pool of 10 puts us at 120, leaving room for the 4 workers at 4',
        'each and ~60 spare.',
        '',
        '## Failure modes',
        '',
        'The one that matters is pool exhaustion. A leaked connection - checked out and never returned, usually',
        'an early return that skips the release - drains the pool permanently, and the symptom is every request',
        'hanging rather than one endpoint failing. Guard it two ways: checkout has a timeout so a leak degrades',
        'into errors instead of a hang, and the in-use metric alerts when it sits at pool size for more than a',
        'minute.',
        '',
        'Failover is the second: after a failover the pool holds connections to a server that is gone. Validate',
        'on handout rather than on return, so the cost is paid only when a connection is actually used.',
        '',
        '## Not doing',
        '',
        'Read replicas and statement-level routing. Both are worth doing and both need the pool in place first,',
        'so they are follow-ups rather than part of this change.'
      ].join('\n')
    },
    {
      id: 'mock-000007',
      title: 'Design new dashboard layout',
      description: 'Create mockups for the redesigned analytics dashboard',
      status: 'in_progress',
      priority: 2,
      issue_type: 'feature',
      created_at: lastWeek,
      created_by: 'diana',
      updated_at: yesterday,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 1,
      assignee: 'diana',
      estimated_minutes: 480,
      labels: ['frontend', 'design', 'ui'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: false
    },
    {
      id: 'mock-000008',
      title: 'Write integration tests for payment module',
      description: 'Cover all payment flows including edge cases',
      status: 'in_progress',
      priority: 1,
      issue_type: 'task',
      created_at: lastWeek,
      created_by: 'bob',
      updated_at: now,
      closed_at: null,
      close_reason: null,
      dependency_count: 1,
      dependent_count: 0,
      assignee: 'bob',
      estimated_minutes: 600,
      labels: ['testing', 'payments'],
      external_ref: 'PROJ-175',
      pinned: false,
      blocked_by_count: 0,
      is_ready: false
    },
    {
      id: 'mock-000009',
      title: 'Migrate to Node 22',
      description: 'Update runtime and fix any compatibility issues',
      status: 'in_progress',
      priority: 3,
      issue_type: 'chore',
      created_at: twoWeeksAgo,
      created_by: 'eve',
      updated_at: lastWeek,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 0,
      assignee: 'eve',
      estimated_minutes: 120,
      labels: ['devops', 'infrastructure'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: false
    },

    // --- Blocked column (status=blocked or open with blocked_by_count > 0) ---
    {
      id: 'mock-000010',
      title: 'Deploy to production',
      description: 'Release v2.0 to production environment',
      status: 'blocked',
      priority: 0,
      issue_type: 'task',
      created_at: lastWeek,
      created_by: 'alice',
      updated_at: yesterday,
      closed_at: null,
      close_reason: null,
      dependency_count: 4,
      dependent_count: 0,
      assignee: 'alice',
      estimated_minutes: 60,
      labels: ['devops', 'release', 'P0'],
      external_ref: 'PROJ-200',
      pinned: true,
      blocked_by_count: 4,
      is_ready: false,
      blocked_by: [
        { id: 'mock-000005', title: 'Update API documentation' },
        { id: 'mock-000006', title: 'Refactor database connection pooling' },
        { id: 'mock-000007', title: 'Design new dashboard layout' },
        { id: 'mock-platform-000010.1.4.9', title: 'Migrate the shared auth client' }
      ],
      // Long-form fixture: a release-coordination thread long enough to push
      // the comments list past the inner form's scroll boundary.
      comments: [
        { id: 1, author: 'alice', text: 'Holding this until the pooling change (PROJ-150) is out of code review. Shipping both in the same window means we cannot tell which one moved p99 if it moves the wrong way.', created_at: twoWeeksAgo },
        { id: 2, author: 'bob', text: 'Agreed on sequencing. One thing to flag: the migration in this release adds a NOT NULL column to `sessions`, which locks the table on the old engine. On our row count that is roughly 40 seconds. Doing it during the Tuesday batch window would be bad.', created_at: twoWeeksAgo },
        { id: 3, author: 'alice', text: 'Good catch. Can we split it - add the column nullable, backfill in batches, then add the constraint once the backfill is done? That is three deploys instead of one but none of them lock.', created_at: lastWeek },
        { id: 4, author: 'bob', text: 'Yes, and the backfill can run from the worker fleet so it does not compete with request traffic. I will write it up as a separate issue and link it as a blocker rather than growing this one.', created_at: lastWeek },
        { id: 5, author: 'charlie', text: 'From the client side: the auth client migration has to land before this, not after. The new session shape is what the refreshed client reads. If this ships first, every mobile client on the current release starts getting 401s on refresh.', created_at: lastWeek },
        { id: 6, author: 'alice', text: 'That reorders things. Sequence is now: auth client migration, then the column split, then the pooling change, then this. Updating the blockers to match.', created_at: yesterday },
        { id: 7, author: 'diana', text: 'Please add a rollback note to the release doc before this goes out. Last release we found out during the incident that the config flag only half-reverted - the feature flag came back but the cache keys had already been rewritten to the new format, so the old code path could not read them.', created_at: yesterday },
        { id: 8, author: 'alice', text: 'Added. Rollback is: flip the flag, then run the cache-key rewrite in reverse. The reverse script is in the release branch and I have tested it against a staging snapshot.', created_at: now },
        { id: 9, author: 'bob', text: 'Backfill finished in staging - 14 minutes, no lock contention, no error budget spent. Running it against production tonight.', created_at: now }
      ]
    },
    {
      id: 'mock-000011',
      title: 'Update user permissions schema',
      description: 'Add new role-based access control fields to the database',
      status: 'open',
      priority: 2,
      issue_type: 'task',
      created_at: twoWeeksAgo,
      created_by: 'charlie',
      updated_at: lastWeek,
      closed_at: null,
      close_reason: null,
      dependency_count: 1,
      dependent_count: 2,
      assignee: 'charlie',
      estimated_minutes: 240,
      labels: ['backend', 'auth'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 1,
      is_ready: false
    },
    {
      id: 'mock-000012',
      title: 'Performance audit for mobile clients',
      description: 'Profile and optimize API response times for mobile app',
      status: 'blocked',
      priority: 1,
      issue_type: 'task',
      created_at: lastWeek,
      created_by: 'diana',
      updated_at: lastWeek,
      closed_at: null,
      close_reason: null,
      dependency_count: 2,
      dependent_count: 0,
      assignee: null,
      estimated_minutes: 480,
      labels: ['performance', 'mobile'],
      external_ref: 'PROJ-188',
      pinned: false,
      blocked_by_count: 2,
      is_ready: false
    },

    // --- Closed column (status=closed) ---
    {
      id: 'mock-000013',
      title: 'Set up CI/CD pipeline',
      description: 'Configure GitHub Actions for automated testing and deployment',
      status: 'closed',
      priority: 1,
      issue_type: 'task',
      created_at: twoWeeksAgo,
      created_by: 'bob',
      updated_at: lastWeek,
      closed_at: lastWeek,
      close_reason: 'completed',
      dependency_count: 0,
      dependent_count: 4,
      assignee: 'bob',
      estimated_minutes: 360,
      labels: ['devops', 'ci'],
      external_ref: 'PROJ-050',
      pinned: false,
      blocked_by_count: 0,
      is_ready: false
    },
    {
      id: 'mock-000014',
      title: 'Fix login redirect on Safari',
      description: 'Users on Safari were not redirected after OAuth login',
      status: 'closed',
      priority: 0,
      issue_type: 'bug',
      created_at: twoWeeksAgo,
      created_by: 'charlie',
      updated_at: lastWeek,
      closed_at: lastWeek,
      close_reason: 'completed',
      dependency_count: 0,
      dependent_count: 0,
      assignee: 'charlie',
      estimated_minutes: 60,
      labels: ['bug', 'auth', 'safari'],
      external_ref: 'PROJ-089',
      pinned: false,
      blocked_by_count: 0,
      is_ready: false
    },
    {
      id: 'mock-000015',
      title: 'Initial project scaffolding',
      description: 'Create repo, set up TypeScript, ESLint, testing framework',
      status: 'closed',
      priority: 1,
      issue_type: 'epic',
      created_at: twoWeeksAgo,
      created_by: 'alice',
      updated_at: twoWeeksAgo,
      closed_at: twoWeeksAgo,
      close_reason: 'completed',
      dependency_count: 0,
      dependent_count: 8,
      assignee: 'alice',
      estimated_minutes: 480,
      labels: ['infrastructure', 'setup'],
      external_ref: 'PROJ-001',
      pinned: false,
      blocked_by_count: 0,
      is_ready: false
    },
    {
      id: 'mock-000016',
      title: 'Fix typo in contribution guidelines',
      description: 'Corrected several misspellings in CONTRIBUTING.md',
      status: 'closed',
      priority: 4,
      issue_type: 'chore',
      created_at: lastWeek,
      created_by: 'eve',
      updated_at: lastWeek,
      closed_at: lastWeek,
      close_reason: 'completed',
      dependency_count: 0,
      dependent_count: 0,
      assignee: null,
      estimated_minutes: 10,
      labels: ['docs'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: false
    },
    {
      id: 'mock-000017',
      title: 'Evaluate database migration tools',
      description: 'Compare Flyway, Liquibase, and custom migration approaches',
      status: 'deferred',
      priority: 2,
      issue_type: 'task',
      created_at: twoWeeksAgo,
      created_by: 'diana',
      updated_at: lastWeek,
      closed_at: null,
      dependency_count: 0,
      dependent_count: 0,
      assignee: 'diana',
      estimated_minutes: 240,
      labels: ['backend', 'database', 'evaluation'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: false
    },
    // --- Parent/child hierarchy fixtures (Tree view) -----------------------
    // Depth-4 chain plus sibling mix exercising every connector case:
    //   mock-000024 (epic, root)
    //   ├── mock-000025 (feature)         — non-last child with a deep chain,
    //   │   ├── mock-000026 (task)          so its descendants render under a
    //   │   │   └── mock-000031 (task)      passthrough guide column
    //   │   └── mock-000027 (task)        — elbow under a passthrough
    //   ├── mock-000028 (task, closed)    — tee, hidden by the default
    //   └── mock-000029 (bug)               Active status filter
    //   mock-000030                       — orphan (parent not in dataset)
    //   mock-000032                       — second flat root
    {
      id: 'mock-000024',
      title: 'Platform revamp',
      description: 'Umbrella epic for the platform modernization effort',
      status: 'open',
      priority: 1,
      issue_type: 'epic',
      created_at: twoWeeksAgo,
      created_by: 'alice',
      updated_at: now,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 3,
      assignee: 'alice',
      estimated_minutes: null,
      labels: ['platform'],
      external_ref: 'PROJ-200',
      pinned: false,
      blocked_by_count: 0,
      is_ready: true,
      children: [
        { id: 'mock-000025', title: 'Modernize authentication stack' },
        { id: 'mock-000028', title: 'Audit current platform dependencies' },
        { id: 'mock-000029', title: 'Login page flickers on slow connections' }
      ]
    },
    {
      id: 'mock-000025',
      title: 'Modernize authentication stack',
      description: 'Replace the legacy session store with token-based auth',
      status: 'in_progress',
      priority: 1,
      issue_type: 'feature',
      created_at: twoWeeksAgo,
      created_by: 'alice',
      updated_at: yesterday,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 2,
      assignee: 'bob',
      estimated_minutes: 960,
      labels: ['auth', 'platform'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: false,
      parent: { id: 'mock-000024', title: 'Platform revamp' },
      children: [
        { id: 'mock-000026', title: 'Implement token refresh service' },
        { id: 'mock-000027', title: 'Document new auth endpoints' }
      ]
    },
    {
      id: 'mock-000026',
      title: 'Implement token refresh service',
      description: 'Background service that rotates access tokens before expiry',
      status: 'open',
      priority: 2,
      issue_type: 'task',
      created_at: lastWeek,
      created_by: 'bob',
      updated_at: lastWeek,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 1,
      assignee: 'bob',
      estimated_minutes: 240,
      labels: ['auth', 'backend'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: true,
      parent: { id: 'mock-000025', title: 'Modernize authentication stack' },
      children: [
        { id: 'mock-000031', title: 'Add retry and backoff to refresh client' }
      ]
    },
    {
      id: 'mock-000027',
      title: 'Document new auth endpoints',
      description: 'OpenAPI specs and integration guide for the new auth API',
      status: 'open',
      priority: 3,
      issue_type: 'task',
      created_at: lastWeek,
      created_by: 'diana',
      updated_at: twoWeeksAgo,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 0,
      assignee: 'diana',
      estimated_minutes: 120,
      labels: ['docs', 'auth'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: true,
      parent: { id: 'mock-000025', title: 'Modernize authentication stack' }
    },
    {
      id: 'mock-000028',
      title: 'Audit current platform dependencies',
      description: 'Inventory of libraries and services slated for replacement',
      status: 'closed',
      priority: 2,
      issue_type: 'task',
      created_at: twoWeeksAgo,
      created_by: 'charlie',
      updated_at: lastWeek,
      closed_at: lastWeek,
      close_reason: 'Completed',
      dependency_count: 0,
      dependent_count: 0,
      assignee: 'charlie',
      estimated_minutes: 180,
      labels: ['platform'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: false,
      parent: { id: 'mock-000024', title: 'Platform revamp' }
    },
    {
      id: 'mock-000029',
      title: 'Login page flickers on slow connections',
      description: 'Regression observed while testing the revamped login flow',
      status: 'blocked',
      priority: 0,
      issue_type: 'bug',
      created_at: yesterday,
      created_by: 'charlie',
      updated_at: yesterday,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 0,
      assignee: 'charlie',
      estimated_minutes: 60,
      labels: ['bug', 'auth'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: false,
      parent: { id: 'mock-000024', title: 'Platform revamp' }
    },
    {
      id: 'mock-000030',
      title: 'Migrate analytics events to new pipeline',
      description: 'Parent epic exists in another workspace, so this renders as an orphan top-level row',
      status: 'open',
      priority: 2,
      issue_type: 'task',
      created_at: lastWeek,
      created_by: 'diana',
      updated_at: yesterday,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 0,
      assignee: 'diana',
      estimated_minutes: 300,
      labels: ['analytics'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: true,
      parent: { id: 'mock-999999', title: 'Epic not in this dataset' }
    },
    {
      id: 'mock-000031',
      title: 'Add retry and backoff to refresh client',
      description: 'Depth-3 subtask exercising nested connector guides',
      status: 'open',
      priority: 2,
      issue_type: 'task',
      created_at: yesterday,
      created_by: 'bob',
      updated_at: now,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 0,
      assignee: 'bob',
      estimated_minutes: 90,
      labels: ['auth', 'backend'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: true,
      parent: { id: 'mock-000026', title: 'Implement token refresh service' }
    },
    {
      id: 'mock-000032',
      title: 'Quarterly cost review',
      description: 'Flat top-level row so root ordering under tree sort is observable',
      status: 'open',
      priority: 3,
      issue_type: 'chore',
      created_at: lastWeek,
      created_by: 'alice',
      updated_at: lastWeek,
      closed_at: null,
      close_reason: null,
      dependency_count: 0,
      dependent_count: 0,
      assignee: null,
      estimated_minutes: 120,
      labels: ['ops'],
      external_ref: null,
      pinned: false,
      blocked_by_count: 0,
      is_ready: true
    }
  ];
}

/**
 * Two cards in the default dataset carry deliberately hostile titles — a
 * 200-character overflow case and an XSS probe. They earn their place: the
 * webview needs both exercised. They are useless in a README screenshot, so
 * --dataset=showcase swaps those two titles for ordinary ones and leaves
 * everything else — statuses, hierarchy, labels, assignees — alone. One
 * dataset, one structure, no second copy to keep in sync.
 *
 * Titles are duplicated into `children[]` and `parent` references, so those
 * are rewritten too or the tree and detail panes would disagree with the card.
 */
var SHOWCASE_TITLE_OVERRIDES = {
  'mock-000002': 'Rate-limit the public search endpoint',
  'mock-000003': 'Session cookie survives sign-out on Firefox'
};

function applyShowcaseTitles(cards) {
  function retitle(ref) {
    if (ref && Object.prototype.hasOwnProperty.call(SHOWCASE_TITLE_OVERRIDES, ref.id)) {
      ref.title = SHOWCASE_TITLE_OVERRIDES[ref.id];
    }
  }
  cards.forEach(function(card) {
    retitle(card);
    if (Array.isArray(card.children)) { card.children.forEach(retitle); }
    retitle(card.parent);
  });
  return cards;
}

function getBoardData() {
  var cards = generateMockBoardData();
  return DATASET === 'showcase' ? applyShowcaseTitles(cards) : cards;
}

// ---------------------------------------------------------------------------
// VS Code Theme CSS Variables
// ---------------------------------------------------------------------------

/**
 * Generate CSS custom properties that mimic the VS Code theme.
 * The webview's styles.css uses these variables for theming.
 */
function getThemeCss(theme) {
  if (theme === 'light') {
    return [
      ':root {',
      '  --vscode-editor-background: #ffffff;',
      '  --vscode-editor-foreground: #1e1e1e;',
      '  --vscode-sideBar-background: #f3f3f3;',
      '  --vscode-sideBarSectionHeader-background: #e8e8e8;',
      '  --vscode-input-background: #ffffff;',
      '  --vscode-input-foreground: #1e1e1e;',
      '  --vscode-input-border: #cecece;',
      '  --vscode-input-placeholderForeground: #767676;',
      '  --vscode-focusBorder: #0078d4;',
      '  --vscode-button-background: #0078d4;',
      '  --vscode-button-foreground: #ffffff;',
      '  --vscode-button-hoverBackground: #0066b8;',
      '  --vscode-button-secondaryBackground: #e5e5e5;',
      '  --vscode-button-secondaryForeground: #1e1e1e;',
      '  --vscode-button-secondaryHoverBackground: #cccccc;',
      '  --vscode-badge-background: #0078d4;',
      '  --vscode-badge-foreground: #ffffff;',
      '  --vscode-list-hoverBackground: #e8e8e8;',
      '  --vscode-list-activeSelectionBackground: #0078d4;',
      '  --vscode-list-activeSelectionForeground: #ffffff;',
      '  --vscode-textLink-foreground: #006ab1;',
      '  --vscode-foreground: #1e1e1e;',
      '  --vscode-descriptionForeground: #717171;',
      '  --vscode-errorForeground: #f85149;',
      '  --vscode-widget-border: #d4d4d4;',
      '  --vscode-widget-shadow: rgba(0, 0, 0, 0.16);',
      '  --vscode-scrollbar-shadow: rgba(0, 0, 0, 0.1);',
      '  --vscode-dropdown-background: #ffffff;',
      '  --vscode-dropdown-foreground: #1e1e1e;',
      '  --vscode-dropdown-border: #cecece;',
      '  --vscode-checkbox-background: #ffffff;',
      '  --vscode-checkbox-border: #cecece;',
      '  --vscode-checkbox-foreground: #1e1e1e;',
      '  --vscode-textBlockQuote-background: #f2f2f2;',
      '  --vscode-textBlockQuote-border: #0078d4;',
      '  --vscode-panel-border: #e5e5e5;',
      '}',
      'body { color-scheme: light; }'
    ].join('\n');
  }

  // Default: Dark theme (VS Code Dark+)
  return [
    ':root {',
    '  --vscode-editor-background: #1e1e1e;',
    '  --vscode-editor-foreground: #d4d4d4;',
    '  --vscode-sideBar-background: #252526;',
    '  --vscode-sideBarSectionHeader-background: #333333;',
    '  --vscode-input-background: #3c3c3c;',
    '  --vscode-input-foreground: #cccccc;',
    '  --vscode-input-border: #3c3c3c;',
    '  --vscode-input-placeholderForeground: #a0a0a0;',
    '  --vscode-focusBorder: #007acc;',
    '  --vscode-button-background: #0e639c;',
    '  --vscode-button-foreground: #ffffff;',
    '  --vscode-button-hoverBackground: #1177bb;',
    '  --vscode-button-secondaryBackground: #3a3d41;',
    '  --vscode-button-secondaryForeground: #cccccc;',
    '  --vscode-button-secondaryHoverBackground: #4a4d51;',
    '  --vscode-badge-background: #4d4d4d;',
    '  --vscode-badge-foreground: #d4d4d4;',
    '  --vscode-list-hoverBackground: #2a2d2e;',
    '  --vscode-list-activeSelectionBackground: #094771;',
    '  --vscode-list-activeSelectionForeground: #ffffff;',
    '  --vscode-textLink-foreground: #3794ff;',
    '  --vscode-foreground: #cccccc;',
    '  --vscode-descriptionForeground: #9d9d9d;',
    '  --vscode-errorForeground: #f85149;',
    '  --vscode-widget-border: #303031;',
    '  --vscode-widget-shadow: rgba(0, 0, 0, 0.36);',
    '  --vscode-scrollbar-shadow: rgba(0, 0, 0, 0.25);',
    '  --vscode-dropdown-background: #3c3c3c;',
    '  --vscode-dropdown-foreground: #cccccc;',
    '  --vscode-dropdown-border: #3c3c3c;',
    '  --vscode-checkbox-background: #3c3c3c;',
    '  --vscode-checkbox-border: #3c3c3c;',
    '  --vscode-checkbox-foreground: #cccccc;',
    '  --vscode-textBlockQuote-background: #2b2b2b;',
    '  --vscode-textBlockQuote-border: #007acc;',
    '  --vscode-panel-border: #2b2b2b;',
    '}',
    'body { color-scheme: dark; }'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// HTML Generation
// ---------------------------------------------------------------------------

/**
 * Generate the standalone HTML page.
 * This mirrors the structure from src/webview.ts but adapted for standalone use.
 * Differences:
 * - No CSP nonce (not in VS Code sandbox)
 * - Mock acquireVsCodeApi injected before board.js
 * - VS Code theme CSS variables injected
 * - Scripts loaded from HTTP server paths
 */
function generateHtml() {
  // Escape </ sequences in JSON to prevent premature script tag closure (XSS test card has <script> in title)
  var mockCards = JSON.stringify(getBoardData()).replace(/<\//g, '<\\/');
  var themeCss = getThemeCss(THEME);
  var modKey = 'Ctrl';
  var rowIndent = ' '.repeat(12);
  var optionIndent = ' '.repeat(14);

  return '<!DOCTYPE html>\n' +
'<!-- Beads Kanban - Standalone Visual Test Server -->\n' +
'<html lang="en">\n' +
'<head>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'  <title>Beads Kanban - Visual Test</title>\n' +
'  <style>\n' +
'    ' + themeCss + '\n' +
'  </style>\n' +
'  <link href="/media/styles.css" rel="stylesheet" />\n' +
'  <link href="/media/graph-styles.css" rel="stylesheet" />\n' +
'  <style>\n' +
'    /* Visual test server indicator */\n' +
'    .vts-banner {\n' +
'      position: fixed;\n' +
'      bottom: 8px;\n' +
'      right: 8px;\n' +
'      background: rgba(14, 99, 156, 0.85);\n' +
'      color: #fff;\n' +
'      font-size: 11px;\n' +
'      padding: 3px 8px;\n' +
'      border-radius: 4px;\n' +
'      z-index: 99999;\n' +
'      pointer-events: none;\n' +
'      font-family: -apple-system, BlinkMacSystemFont, sans-serif;\n' +
'    }\n' +
'  </style>\n' +
'</head>\n' +
'<body>\n' +
'  <header class="topbar">\n' +
'    <div class="title">\n' +
'      <span class="title-text">Better Beads Kanban</span>\n' +
'      <button id="repoMenuBtn" class="repo-menu-btn" title="Select Repository">&#x22EF;</button>\n' +
'    </div>\n' +
'    <div class="actions">\n' +
'      <div class="view-toggle">\n' +
'        <button id="viewKanbanBtn" class="view-toggle-btn active">Kanban</button>\n' +
'        <button id="viewTableBtn" class="view-toggle-btn">Table</button>\n' +
'        <button id="viewTreeBtn" class="view-toggle-btn">Tree</button>\n' +
'        <button id="viewGraphBtn" class="view-toggle-btn">Graph</button>\n' +
'      </div>\n' +
'      <div class="filters">\n' +
'        <input id="filterSearch" type="text" placeholder="Search... (' + modKey + '+F)" title="Focus search (' + modKey + '+F)" class="search-input" />\n' +
'        <div class="status-filter-wrapper">\n' +
'          <button id="filterPriorityBtn" class="select status-filter-btn" type="button" title="Filter by priority">\n' +
'            <span id="filterPriorityLabel">Priority: All</span>\n' +
'            <span class="dropdown-arrow">&#x25BC;</span>\n' +
'          </button>\n' +
'          <div id="filterPriorityDropdown" class="status-dropdown hidden">\n' +
'            ' + filterMarkup.buildPriorityFilterRows(rowIndent) + '\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="status-filter-wrapper">\n' +
'          <button id="filterTypeBtn" class="select status-filter-btn" type="button" title="Filter by type">\n' +
'            <span id="filterTypeLabel">Type: All</span>\n' +
'            <span class="dropdown-arrow">&#x25BC;</span>\n' +
'          </button>\n' +
'          <div id="filterTypeDropdown" class="status-dropdown hidden">\n' +
'            ' + filterMarkup.buildTypeFilterRows(rowIndent) + '\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="status-filter-wrapper">\n' +
'          <button id="filterStatusBtn" class="select status-filter-btn" type="button" title="Filter by status">\n' +
'            <span id="filterStatusLabel">Status: Active</span>\n' +
'            <span class="dropdown-arrow">&#x25BC;</span>\n' +
'          </button>\n' +
'          <div id="filterStatusDropdown" class="status-dropdown hidden">\n' +
'            ' + filterMarkup.buildStatusFilterRows(rowIndent) + '\n' +
'          </div>\n' +
'        </div>\n' +
'        <button id="clearFiltersBtn" class="btn" title="Clear all filters">Clear Filters</button>\n' +
'      </div>\n' +
'      <button id="refreshBtn" class="btn" title="Refresh board (' + modKey + '+R)">Refresh</button>\n' +
'      <button id="newBtn" class="btn primary" title="Create new issue (' + modKey + '+N)">New</button>\n' +
'    </div>\n' +
'  </header>\n' +
'\n' +
'  <main>\n' +
'    <div id="boardEmptyState" class="empty-state-hint hidden" role="status"></div>\n' +
'    <div id="board" class="board"></div>\n' +
'    <div id="dependencyDiagram" class="dependency-diagram hidden">\n' +
'      <div class="graph-sidebar">\n' +
'        <div class="graph-sidebar-header"><h3>ISSUES</h3></div>\n' +
'        <div id="graphIssueList" class="graph-issue-list"></div>\n' +
'      </div>\n' +
'      <div class="graph-main">\n' +
'        <div class="graph-controls">\n' +
'          <div class="graph-controls-group">\n' +
'            <label><input type="checkbox" id="focusModeToggle" /> Focus Mode</label>\n' +
'            <label for="focusDepth">Depth:</label>\n' +
'            <input type="number" id="focusDepth" min="1" max="5" value="2" style="width: 50px;" />\n' +
'          </div>\n' +
'          <div class="graph-controls-group">\n' +
'            <label for="graphDirection">Direction:</label>\n' +
'            <select id="graphDirection">\n' +
'              <option value="TB">Top to Bottom</option>\n' +
'              <option value="LR">Left to Right</option>\n' +
'            </select>\n' +
'          </div>\n' +
'          <div class="graph-controls-group">\n' +
'            <button id="autoLayoutBtn" class="secondary">Auto Layout</button>\n' +
'            <button id="resetLayoutBtn" class="secondary">Reset View</button>\n' +
'            <button id="centerViewBtn" class="secondary">Center View</button>\n' +
'          </div>\n' +
'          <div class="graph-stats">\n' +
'            <div class="graph-stat"><span class="graph-stat-label">Nodes:</span><span id="nodeCount" class="graph-stat-value">0</span></div>\n' +
'            <div class="graph-stat"><span class="graph-stat-label">Edges:</span><span id="edgeCount" class="graph-stat-value">0</span></div>\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="graph-canvas-container">\n' +
'          <svg id="graphSvg" class="graph-svg"></svg>\n' +
'          <div class="graph-legend">\n' +
'            <h4>Legend</h4>\n' +
'            <div class="graph-legend-section">\n' +
'              <h5>Node Status</h5>\n' +
'              <div class="graph-legend-item"><div class="legend-color-box status-ready"></div><span class="legend-text">Ready</span></div>\n' +
'              <div class="graph-legend-item"><div class="legend-color-box status-in_progress"></div><span class="legend-text">In Progress</span></div>\n' +
'              <div class="graph-legend-item"><div class="legend-color-box status-blocked"></div><span class="legend-text">Blocked</span></div>\n' +
'              <div class="graph-legend-item"><div class="legend-color-box status-closed"></div><span class="legend-text">Closed</span></div>\n' +
'            </div>\n' +
'            <div class="graph-legend-section">\n' +
'              <h5>Dependencies</h5>\n' +
'              <div class="graph-legend-item"><div class="legend-line parent-child"></div><span class="legend-text">Parent-Child</span></div>\n' +
'              <div class="graph-legend-item"><div class="legend-line blocks"></div><span class="legend-text">Blocks</span></div>\n' +
'              <div class="graph-legend-item"><div class="legend-line blocked-by"></div><span class="legend-text">Blocked By</span></div>\n' +
'            </div>\n' +
'          </div>\n' +
'          <div class="zoom-controls">\n' +
'            <button id="zoomInBtn" title="Zoom In">+</button>\n' +
'            <button id="zoomOutBtn" title="Zoom Out">&#x2212;</button>\n' +
'            <button id="zoomResetBtn" title="Reset Zoom">&#x2299;</button>\n' +
'          </div>\n' +
'        </div>\n' +
'      </div>\n' +
'      <div id="graphContextMenu" class="graph-context-menu hidden">\n' +
'        <div class="context-menu-item" data-action="link">Link Selected Issues</div>\n' +
'        <div class="context-menu-item" data-action="unlink">Remove Dependency</div>\n' +
'        <div class="context-menu-separator"></div>\n' +
'        <div class="context-menu-item" data-action="focus">Focus on Node</div>\n' +
'      </div>\n' +
'    </div>\n' +
'  </main>\n' +
'\n' +
'  <!-- Static Edit Issue Dialog -->\n' +
'  <dialog id="detailDialog" class="dialog">\n' +
'    <form method="dialog" class="dialogForm">\n' +
'      <div class="edit-form-container">\n' +
'        <h3 id="editFormHeader" class="form-section-header">Edit Issue</h3>\n' +
'        <div class="form-row">\n' +
'          <label class="form-label" for="editTitle">Title:</label>\n' +
'          <input id="editTitle" type="text" maxlength="500" class="form-input-title" placeholder="Issue title" autofocus />\n' +
'        </div>\n' +
'        <div class="form-row-multi">\n' +
'          <div class="form-group">\n' +
'            <label class="form-label" for="editStatus">Status:</label>\n' +
'            <select id="editStatus" class="form-input-inline">\n' +
'              <option value="open">Open</option>\n' +
'              <option value="in_progress">In Progress</option>\n' +
'              <option value="blocked">Blocked</option>\n' +
'              <option value="deferred">Deferred</option>\n' +
'              <option value="closed">Closed</option>\n' +
'            </select>\n' +
'          </div>\n' +
'          <div class="form-group">\n' +
'            <label class="form-label" for="editType">Type:</label>\n' +
'            <select id="editType" class="form-input-inline">\n' +
'              ' + filterMarkup.buildEditTypeOptions(optionIndent) + '\n' +
'            </select>\n' +
'          </div>\n' +
'          <div class="form-group">\n' +
'            <label class="form-label" for="editPriority">Priority:</label>\n' +
'            <select id="editPriority" class="form-input-inline">\n' +
'              ' + filterMarkup.buildEditPriorityOptions(optionIndent) + '\n' +
'            </select>\n' +
'          </div>\n' +
'          <div class="form-group-large">\n' +
'            <label class="form-label" for="editAssignee">Assignee:</label>\n' +
'            <input id="editAssignee" type="text" maxlength="100" placeholder="Unassigned" class="form-input-inline" />\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="form-row-multi">\n' +
'          <div class="form-group">\n' +
'            <label class="form-label" for="editEst">Est. Minutes:</label>\n' +
'            <input id="editEst" type="number" min="0" step="1" placeholder="Min" class="form-input-inline" />\n' +
'          </div>\n' +
'          <div class="form-group">\n' +
'            <label class="form-label" for="editDueAt">Due At:</label>\n' +
'            <input id="editDueAt" type="datetime-local" class="form-input-inline" />\n' +
'          </div>\n' +
'          <div class="form-group">\n' +
'            <label class="form-label" for="editDeferUntil">Defer Until:</label>\n' +
'            <input id="editDeferUntil" type="datetime-local" class="form-input-inline" />\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="form-section">\n' +
'          <label class="form-label-small">Tags</label>\n' +
'          <div id="labelsContainer" class="labels-container"></div>\n' +
'          <div class="inline-add-row">\n' +
'            <input id="newLabel" type="text" placeholder="Add tag..." class="inline-input" />\n' +
'            <button type="button" id="btnAddLabel" class="btn btn-small">+</button>\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="form-section">\n' +
'          <label class="form-label-small">Flags</label>\n' +
'          <div class="flags-row">\n' +
'            <label class="flag-label"><input type="checkbox" id="editPinned" /> &#x1F4CC; Pinned</label>\n' +
'            <label class="flag-label"><input type="checkbox" id="editTemplate" /> &#x1F4C4; Template</label>\n' +
'            <label class="flag-label"><input type="checkbox" id="editEphemeral" /> &#x23F1; Ephemeral</label>\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="form-row-wide-label">\n' +
'          <label class="form-label" for="editExtRef">Ext Ref:</label>\n' +
'          <input id="editExtRef" type="text" maxlength="200" placeholder="JIRA-123" class="form-input-full" />\n' +
'        </div>\n' +
'        <hr class="form-hr">\n' +
'        <div class="markdown-fields-container">\n' +
'          <div class="markdown-field-wrapper">\n' +
'            <div class="markdown-field-header">\n' +
'              <label class="form-label-small" for="editDesc">Description</label>\n' +
'              <button type="button" class="btn btn-small toggle-preview" data-target="editDesc">Preview</button>\n' +
'            </div>\n' +
'            <textarea id="editDesc" class="markdown-field-editor" rows="4"></textarea>\n' +
'            <div id="editDesc-preview" class="markdown-body markdown-field-preview hidden"></div>\n' +
'          </div>\n' +
'          <div class="markdown-field-wrapper">\n' +
'            <div class="markdown-field-header">\n' +
'              <label class="form-label-small" for="editAC">Acceptance Criteria</label>\n' +
'              <button type="button" class="btn btn-small toggle-preview" data-target="editAC">Preview</button>\n' +
'            </div>\n' +
'            <textarea id="editAC" class="markdown-field-editor" rows="3"></textarea>\n' +
'            <div id="editAC-preview" class="markdown-body markdown-field-preview hidden"></div>\n' +
'          </div>\n' +
'          <div class="markdown-field-wrapper">\n' +
'            <div class="markdown-field-header">\n' +
'              <label class="form-label-small" for="editDesign">Design Notes</label>\n' +
'              <button type="button" class="btn btn-small toggle-preview" data-target="editDesign">Preview</button>\n' +
'            </div>\n' +
'            <textarea id="editDesign" class="markdown-field-editor" rows="3"></textarea>\n' +
'            <div id="editDesign-preview" class="markdown-body markdown-field-preview hidden"></div>\n' +
'          </div>\n' +
'          <div class="markdown-field-wrapper">\n' +
'            <div class="markdown-field-header">\n' +
'              <label class="form-label-small" for="editNotes">Notes</label>\n' +
'              <button type="button" class="btn btn-small toggle-preview" data-target="editNotes">Preview</button>\n' +
'            </div>\n' +
'            <textarea id="editNotes" class="markdown-field-editor" rows="3"></textarea>\n' +
'            <div id="editNotes-preview" class="markdown-body markdown-field-preview hidden"></div>\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="form-section-bordered">\n' +
'          <label class="form-label-small section-label">Structure</label>\n' +
'          <div class="relationship-group">\n' +
'            <span class="relationship-label">Parent:</span>\n' +
'            <span id="parentDisplay" class="relationship-value">None</span>\n' +
'            <span id="removeParent" class="remove-link hidden">(Unlink)</span>\n' +
'          </div>\n' +
'          <div id="parentAddRow" class="inline-add-row">\n' +
'            <input id="newParentId" type="text" placeholder="Parent Issue ID" list="issueIdOptions" class="inline-input" />\n' +
'            <button type="button" id="btnSetParent" class="btn btn-small">Set</button>\n' +
'          </div>\n' +
'          <div class="relationship-group"><span class="relationship-label">Blocked By:</span></div>\n' +
'          <ul id="blockedByList" class="relationship-list"></ul>\n' +
'          <div class="inline-add-row">\n' +
'            <input id="newBlockerId" type="text" placeholder="Blocker Issue ID" list="issueIdOptions" class="inline-input" />\n' +
'            <button type="button" id="btnAddBlocker" class="btn btn-small">Add</button>\n' +
'          </div>\n' +
'          <div class="relationship-group"><span class="relationship-label">Blocks:</span></div>\n' +
'          <ul id="blocksList" class="relationship-list"></ul>\n' +
'          <div class="relationship-group"><span class="relationship-label">Children:</span></div>\n' +
'          <ul id="childrenList" class="relationship-list"></ul>\n' +
'          <div class="inline-add-row">\n' +
'            <input id="newChildId" type="text" placeholder="Child Issue ID" list="issueIdOptions" class="inline-input" />\n' +
'            <button type="button" id="btnAddChild" class="btn btn-small">Add</button>\n' +
'          </div>\n' +
'        </div>\n' +
'        <datalist id="issueIdOptions"></datalist>\n' +
'        <details id="advancedMetadata" class="form-section-bordered hidden">\n' +
'          <summary class="form-label-small section-label clickable">Advanced Metadata (Event/Agent)</summary>\n' +
'          <div id="advancedMetadataContent" class="metadata-grid"></div>\n' +
'        </details>\n' +
'        <div class="form-section-bordered">\n' +
'          <label class="form-label-small section-label">Comments</label>\n' +
'          <div id="commentsList" class="comments-list"></div>\n' +
'          <div class="comment-add-row">\n' +
'            <textarea id="newCommentText" rows="2" placeholder="Write a comment..." class="comment-input"></textarea>\n' +
'            <button type="button" id="btnPostComment" class="btn">Post</button>\n' +
'          </div>\n' +
'          <div id="createModeCommentNote" class="muted-note hidden">Comments will be added after issue creation.</div>\n' +
'        </div>\n' +
'        <div class="dialogActions form-actions">\n' +
'          <div class="actions-left">\n' +
'            <button type="button" id="btnSave" class="btn primary">Save Changes</button>\n' +
'            <button type="button" id="btnClose" class="btn">Close</button>\n' +
'          </div>\n' +
'          <div class="actions-right">\n' +
'            <button type="button" id="btnChat" class="btn icon-btn" title="Add to Chat">&#x1F4AC; Chat</button>\n' +
'            <button type="button" id="btnCopy" class="btn icon-btn" title="Copy Context">&#x1F4CB; Copy</button>\n' +
'          </div>\n' +
'        </div>\n' +
'        <div id="editFormFooter" class="form-footer"></div>\n' +
'      </div>\n' +
'    </form>\n' +
'  </dialog>\n' +
'\n' +
'  <div id="toast" class="toast hidden"></div>\n' +
'\n' +
'  <div id="loadingOverlay" class="loading-overlay hidden">\n' +
'    <div class="loading-spinner"></div>\n' +
'    <div id="loadingText" class="loading-text">Loading...</div>\n' +
'  </div>\n' +
'\n' +
'  <div class="vts-banner">Visual Test Server (mock data)</div>\n' +
'\n' +
'  <!-- DOMPurify and marked for markdown rendering -->\n' +
'  <script src="/media/purify.min.js"></script>\n' +
'  <script src="/media/marked.min.js"></script>\n' +
'\n' +
'  <!-- Mock VS Code API - must be loaded BEFORE board.js -->\n' +
'  <script>\n' +
'    // Mock VS Code API for standalone testing\n' +
'    var _mockBoardCards = ' + mockCards + ';\n' +
'    var _mockMessageLog = [];\n' +
'    var _mockState = {};\n' +
'\n' +
'    // Mutations are applied to _mockBoardCards before mutation.ok is sent.\n' +
'    // Anything less makes a write a no-op the moment the UI re-reads it:\n' +
'    // the edit dialog refetches through issue.getFull after a relationship\n' +
'    // change, and a save or a drag refetches the whole board. Under a mock\n' +
'    // that only answers "ok", working and broken code render identically.\n' +
'    function _mockSendBoard(requestId) {\n' +
'      var response = {\n' +
'        data: {\n' +
'          type: "board.minimal",\n' +
'          requestId: requestId || "mock-req-board",\n' +
'          payload: { cards: _mockBoardCards }\n' +
'        }\n' +
'      };\n' +
'      console.log("[mock-vscode] Responding with board.minimal (" + _mockBoardCards.length + " cards)");\n' +
'      _mockMessageLog.push({ direction: "in", msg: response.data, timestamp: Date.now() });\n' +
'      window.dispatchEvent(new MessageEvent("message", response));\n' +
'    }\n' +
'    function _mockFind(id) {\n' +
'      return _mockBoardCards.find(function(c) { return c.id === id; });\n' +
'    }\n' +
'    function _mockRef(card) { return { id: card.id, title: card.title }; }\n' +
'    function _mockWithRef(list, card) {\n' +
'      list = list || [];\n' +
'      if (!list.some(function(r) { return r.id === card.id; })) { list.push(_mockRef(card)); }\n' +
'      return list;\n' +
'    }\n' +
'    function _mockWithoutRef(list, id) {\n' +
'      return (list || []).filter(function(r) { return r.id !== id; });\n' +
'    }\n' +
'    function _mockRecount(card) {\n' +
'      card.blocked_by_count = (card.blocked_by || []).length;\n' +
'      card.dependency_count = card.blocked_by_count;\n' +
'      card.dependent_count = (card.blocks || []).length;\n' +
'    }\n' +
'    // `bd dep add <issue> <depends-on>`: id depends on otherId, so\n' +
'    // parent-child makes otherId the parent of id, and blocks makes otherId\n' +
'    // a blocker of id. Both directions are stored, matching what bd show\n' +
'    // returns for each side.\n' +
'    function _mockAddDependency(payload) {\n' +
'      var issue = _mockFind(payload.id);\n' +
'      var other = _mockFind(payload.otherId);\n' +
'      if (!issue || !other) { return; }\n' +
'      if (payload.type === "parent-child") {\n' +
'        issue.parent = _mockRef(other);\n' +
'        other.children = _mockWithRef(other.children, issue);\n' +
'      } else {\n' +
'        issue.blocked_by = _mockWithRef(issue.blocked_by, other);\n' +
'        other.blocks = _mockWithRef(other.blocks, issue);\n' +
'      }\n' +
'      _mockRecount(issue);\n' +
'      _mockRecount(other);\n' +
'    }\n' +
'    // `bd dep remove` takes no type and drops whatever edge exists between\n' +
'    // the pair, so this severs both shapes rather than trusting the type the\n' +
'    // webview happened to send.\n' +
'    function _mockRemoveDependency(payload) {\n' +
'      var issue = _mockFind(payload.id);\n' +
'      var other = _mockFind(payload.otherId);\n' +
'      if (!issue || !other) { return; }\n' +
'      if (issue.parent && issue.parent.id === other.id) { issue.parent = null; }\n' +
'      other.children = _mockWithoutRef(other.children, issue.id);\n' +
'      issue.blocked_by = _mockWithoutRef(issue.blocked_by, other.id);\n' +
'      other.blocks = _mockWithoutRef(other.blocks, issue.id);\n' +
'      _mockRecount(issue);\n' +
'      _mockRecount(other);\n' +
'    }\n' +
'    var _mockColumnStatus = {\n' +
'      ready: "open", open: "open", in_progress: "in_progress",\n' +
'      blocked: "blocked", closed: "closed"\n' +
'    };\n' +
'    function _mockApplyMutation(msg) {\n' +
'      var payload = msg.payload || {};\n' +
'      var card = _mockFind(payload.id);\n' +
'      if (msg.type === "issue.addDependency") { _mockAddDependency(payload); return; }\n' +
'      if (msg.type === "issue.removeDependency") { _mockRemoveDependency(payload); return; }\n' +
'      if (msg.type === "issue.create") {\n' +
'        _mockBoardCards.push(Object.assign({\n' +
'          id: payload.__newId, title: "New Issue", description: "", status: "open",\n' +
'          priority: 2, issue_type: "task", created_at: new Date().toISOString(),\n' +
'          created_by: "me", updated_at: new Date().toISOString(), closed_at: null,\n' +
'          close_reason: null, dependency_count: 0, dependent_count: 0, assignee: null,\n' +
'          estimated_minutes: null, labels: [], external_ref: null, pinned: false,\n' +
'          blocked_by_count: 0, is_ready: true, comments: []\n' +
'        }, payload.card));\n' +
'        return;\n' +
'      }\n' +
'      if (!card) { return; }\n' +
'      if (msg.type === "issue.update" && payload.updates) {\n' +
'        Object.keys(payload.updates).forEach(function(k) {\n' +
'          if (payload.updates[k] !== undefined) { card[k] = payload.updates[k]; }\n' +
'        });\n' +
'        card.updated_at = new Date().toISOString();\n' +
'      } else if (msg.type === "issue.move") {\n' +
'        card.status = _mockColumnStatus[payload.toColumn] || card.status;\n' +
'        card.is_ready = card.status === "open" && (card.blocked_by_count || 0) === 0;\n' +
'        card.updated_at = new Date().toISOString();\n' +
'      } else if (msg.type === "issue.addLabel") {\n' +
'        card.labels = card.labels || [];\n' +
'        if (card.labels.indexOf(payload.label) === -1) { card.labels.push(payload.label); }\n' +
'      } else if (msg.type === "issue.removeLabel") {\n' +
'        card.labels = (card.labels || []).filter(function(l) { return l !== payload.label; });\n' +
'      } else if (msg.type === "issue.addComment") {\n' +
'        card.comments = card.comments || [];\n' +
'        card.comments.push({\n' +
'          id: Date.now(), author: payload.author || "Me", text: payload.text,\n' +
'          created_at: new Date().toISOString()\n' +
'        });\n' +
'      }\n' +
'    }\n' +
'\n' +
'    window.acquireVsCodeApi = function() {\n' +
'      return {\n' +
'        postMessage: function(msg) {\n' +
'          console.log("[mock-vscode] postMessage:", msg.type, msg);\n' +
'          _mockMessageLog.push({ direction: "out", msg: msg, timestamp: Date.now() });\n' +
'\n' +
'          // Handle board.loadMinimal - respond with mock board.minimal\n' +
'          if (msg.type === "board.loadMinimal" || msg.type === "board.load" || msg.type === "board.refresh") {\n' +
'            setTimeout(function() { _mockSendBoard(msg.requestId || "mock-req-1"); }, 100);\n' +
'            return;\n' +
'          }\n' +
'\n' +
'          // Handle issue.getFull - respond with mock full card data\n' +
'          if (msg.type === "issue.getFull" && msg.payload && msg.payload.id) {\n' +
'            var card = _mockBoardCards.find(function(c) { return c.id === msg.payload.id; });\n' +
'            if (card) {\n' +
'              setTimeout(function() {\n' +
'                var fullCard = Object.assign({}, card, {\n' +
'                  // A fixture that carries its own long-form text keeps it;\n' +
'                  // the rest get the short sample. Volume-dependent bugs -\n' +
'                  // inner-form scroll, markdown preview height, long comment\n' +
'                  // threads - only reproduce against the long fixtures.\n' +
'                  acceptance_criteria: card.acceptance_criteria || "- [ ] Acceptance criteria item 1\\n- [ ] Acceptance criteria item 2",\n' +
'                  design: card.design || ("## Design Notes\\n\\nSample design notes for **" + card.title + "**"),\n' +
'                  notes: card.notes || "Implementation notes go here.",\n' +
'                  due_at: null,\n' +
'                  defer_until: null,\n' +
'                  is_template: false,\n' +
'                  ephemeral: false,\n' +
'                  // Keep the card own relationships. These used to be hardcoded\n' +
'                  // empty, which silently made the Graph view untestable here:\n' +
'                  // renderGraph() builds every edge from this response, so it\n' +
'                  // always drew zero regardless of the fixture hierarchy.\n' +
'                  parent: card.parent || null,\n' +
'                  children: card.children || [],\n' +
'                  blocks: card.blocks || [],\n' +
'                  blocked_by: card.blocked_by || [],\n' +
'                  // Cards seeded without a comments array get the sample\n' +
'                  // thread; once addComment writes one, that array wins so\n' +
'                  // the posted comment survives a reopen.\n' +
'                  comments: card.comments || [\n' +
'                    { id: 1, author: "alice", text: "This looks good. Ready for review.", created_at: new Date().toISOString() },\n' +
'                    { id: 2, author: "bob", text: "Agreed, merging.", created_at: new Date().toISOString() }\n' +
'                  ]\n' +
'                });\n' +
'                var response = {\n' +
'                  data: {\n' +
'                    type: "issue.full",\n' +
'                    requestId: msg.requestId || "mock-req-full",\n' +
'                    payload: { card: fullCard }\n' +
'                  }\n' +
'                };\n' +
'                console.log("[mock-vscode] Responding with issue.full for " + card.id);\n' +
'                _mockMessageLog.push({ direction: "in", msg: response.data, timestamp: Date.now() });\n' +
'                window.dispatchEvent(new MessageEvent("message", response));\n' +
'              }, 50);\n' +
'            } else {\n' +
'              setTimeout(function() {\n' +
'                window.dispatchEvent(new MessageEvent("message", {\n' +
'                  data: {\n' +
'                    type: "mutation.error",\n' +
'                    requestId: msg.requestId || "mock-req-err",\n' +
'                    error: "Issue not found: " + msg.payload.id\n' +
'                  }\n' +
'                }));\n' +
'              }, 50);\n' +
'            }\n' +
'            return;\n' +
'          }\n' +
'\n' +
'          // Handle mutations - apply to _mockBoardCards, then respond ok\n' +
'          if (msg.type === "issue.create" || msg.type === "issue.update" ||\n' +
'              msg.type === "issue.move" || msg.type === "issue.addComment" ||\n' +
'              msg.type === "issue.addLabel" || msg.type === "issue.removeLabel" ||\n' +
'              msg.type === "issue.addDependency" || msg.type === "issue.removeDependency") {\n' +
'            var created = msg.type === "issue.create"\n' +
'              ? { id: "mock-new-" + Date.now(), title: (msg.payload && msg.payload.title) || "New Issue" }\n' +
'              : null;\n' +
'            try {\n' +
'              _mockApplyMutation(created\n' +
'                ? { type: msg.type, payload: Object.assign({ __newId: created.id, card: msg.payload }, msg.payload) }\n' +
'                : msg);\n' +
'            } catch (err) {\n' +
'              console.warn("[mock-vscode] Failed to apply " + msg.type + ":", err);\n' +
'            }\n' +
'            setTimeout(function() {\n' +
'              var response = {\n' +
'                data: {\n' +
'                  type: "mutation.ok",\n' +
'                  requestId: msg.requestId || "mock-req-mut",\n' +
'                  payload: created || {}\n' +
'                }\n' +
'              };\n' +
'              console.log("[mock-vscode] Applied and responding with mutation.ok for " + msg.type);\n' +
'              _mockMessageLog.push({ direction: "in", msg: response.data, timestamp: Date.now() });\n' +
'              window.dispatchEvent(new MessageEvent("message", response));\n' +
'              // Every mutation handler in src/extension.ts follows mutation.ok\n' +
'              // with sendBoard(). That is what downgrades cardStateLevel back\n' +
'              // to "minimal"; without it loadFullIssue() keeps serving the\n' +
'              // pre-mutation full card and the dialog shows a severed edge as\n' +
'              // still present.\n' +
'              _mockSendBoard(msg.requestId);\n' +
'            }, 50);\n' +
'            return;\n' +
'          }\n' +
'\n' +
'          // Log unhandled messages\n' +
'          console.log("[mock-vscode] Unhandled message type:", msg.type);\n' +
'        },\n' +
'        getState: function() { return _mockState; },\n' +
'        setState: function(s) { _mockState = s; return s; }\n' +
'      };\n' +
'    };\n' +
'  </script>\n' +
'\n' +
'  <!-- Graph view scripts (module type, loaded before board.js) -->\n' +
'  <script type="module" src="/out/webview/graph-layout.js"></script>\n' +
'  <script type="module" src="/out/webview/graph-view.js"></script>\n' +
'\n' +
'  <!-- Board.js bundle (bundled with Pragmatic Drag and Drop) -->\n' +
'  <script src="/out/webview/board.js"></script>\n' +
'</body>\n' +
'</html>';
}

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------
var MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function getMimeType(filePath) {
  var ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
function createServer() {
  return http.createServer(function(req, res) {
    var url = req.url.split('?')[0]; // Strip query string

    // Route: / -> generated HTML
    if (url === '/' || url === '/index.html') {
      var html = generateHtml();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Length': Buffer.byteLength(html)
      });
      res.end(html);
      return;
    }

    // Route: /media/* -> serve from PROJECT_ROOT/media/
    // Route: /out/* -> serve from PROJECT_ROOT/out/
    var filePath = null;
    if (url.startsWith('/media/')) {
      filePath = path.join(PROJECT_ROOT, 'media', url.slice('/media/'.length));
    } else if (url.startsWith('/out/')) {
      filePath = path.join(PROJECT_ROOT, 'out', url.slice('/out/'.length));
    }

    if (filePath) {
      // Security: Prevent directory traversal
      var resolvedPath = path.resolve(filePath);
      if (!resolvedPath.startsWith(path.resolve(PROJECT_ROOT))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      try {
        var content = fs.readFileSync(resolvedPath);
        res.writeHead(200, {
          'Content-Type': getMimeType(resolvedPath),
          'Cache-Control': 'no-cache',
          'Content-Length': content.length
        });
        res.end(content);
      } catch (err) {
        res.writeHead(404);
        res.end('Not found: ' + url);
      }
      return;
    }

    // Fallback: 404
    res.writeHead(404);
    res.end('Not found: ' + url);
  });
}

// ---------------------------------------------------------------------------
// Chrome Launcher
// ---------------------------------------------------------------------------
function launchChrome(url, debugPort) {
  // Try common Chrome locations
  var chromePaths = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe'
  ];

  if (process.platform === 'darwin') {
    chromePaths = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  } else if (process.platform === 'linux') {
    chromePaths = ['google-chrome', 'chromium-browser', 'chromium'];
  }

  var chromePath = null;
  for (var i = 0; i < chromePaths.length; i++) {
    try {
      if (fs.existsSync(chromePaths[i])) {
        chromePath = chromePaths[i];
        break;
      }
    } catch (_e) {
      // On Linux, the path might be a command name, not a file path
      if (process.platform === 'linux') {
        chromePath = chromePaths[i];
        break;
      }
    }
  }

  if (!chromePath) {
    console.log('  WARNING: Could not find Chrome. Please open manually:');
    console.log('    ' + url);
    return null;
  }

  // Create a temporary user-data-dir so we don't interfere with the user's profile
  var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-vts-chrome-'));

  var args = [
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + tempDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-extensions',
    url
  ];

  console.log('  Launching Chrome: ' + chromePath);
  console.log('  Debug port: ' + debugPort);
  console.log('  User data: ' + tempDir);

  // Use spawn with explicit args array (no shell injection risk)
  var useShell = process.platform === 'win32';
  var proc = childProcess.spawn(
    useShell ? ('"' + chromePath + '"') : chromePath,
    args,
    {
      detached: true,
      stdio: 'ignore',
      shell: useShell
    }
  );

  proc.unref();

  return { process: proc, tempDir: tempDir };
}

// ---------------------------------------------------------------------------
// Rebuild helper (uses execFileSync with fixed args - no user input)
// ---------------------------------------------------------------------------
function rebuildWebview() {
  console.log('Building webview bundle...');
  try {
    // Run build-webview script directly via node (avoids npm.cmd issues in Git Bash on Windows)
    childProcess.execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'build-webview.js')], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit'
    });
    console.log('  Build complete.');
    console.log('');
  } catch (err) {
    console.error('  Build failed:', err.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('======================================================================');
  console.log('  Beads Kanban - Standalone Visual Test Server');
  console.log('======================================================================');
  console.log('');

  // -----------------------------------------------------------------------
  // 1. Optionally rebuild webview
  // -----------------------------------------------------------------------
  if (REBUILD) {
    rebuildWebview();
  }

  // Verify required files exist
  var requiredFiles = [
    'out/webview/board.js',
    'media/styles.css',
    'media/purify.min.js',
    'media/marked.min.js'
  ];

  var missing = [];
  for (var i = 0; i < requiredFiles.length; i++) {
    var fullPath = path.join(PROJECT_ROOT, requiredFiles[i]);
    if (!fs.existsSync(fullPath)) {
      missing.push(requiredFiles[i]);
    }
  }

  if (missing.length > 0) {
    console.error('ERROR: Required files are missing:');
    for (var j = 0; j < missing.length; j++) {
      console.error('  - ' + missing[j]);
    }
    console.error('');
    console.error('Run "npm run build-webview" first, or use --rebuild flag.');
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // 2. Start HTTP server
  // -----------------------------------------------------------------------
  var server = createServer();
  var serverUrl = 'http://localhost:' + HTTP_PORT;

  await new Promise(function(resolve, reject) {
    server.on('error', function(err) {
      if (err.code === 'EADDRINUSE') {
        console.error('ERROR: Port ' + HTTP_PORT + ' is already in use.');
        console.error('  Use --port=NNNN to specify a different port.');
        reject(err);
      } else {
        reject(err);
      }
    });
    server.listen(HTTP_PORT, function() {
      resolve();
    });
  });

  console.log('  HTTP server listening on: ' + serverUrl);
  console.log('  Theme: ' + THEME);
  console.log('');

  // -----------------------------------------------------------------------
  // 3. Launch Chrome
  // -----------------------------------------------------------------------
  var chromeInfo = null;
  if (!NO_CHROME) {
    console.log('Launching Chrome...');
    chromeInfo = launchChrome(serverUrl, DEBUG_PORT);
    console.log('');
  }

  // -----------------------------------------------------------------------
  // 4. Print connection info
  // -----------------------------------------------------------------------
  console.log('======================================================================');
  console.log('  Visual Test Server Ready');
  console.log('');
  console.log('  Board URL:     ' + serverUrl);
  console.log('  CDP endpoint:  http://localhost:' + DEBUG_PORT);
  console.log('');
  console.log('  Connect Chrome DevTools MCP:');
  console.log('    npx @anthropic-ai/chrome-devtools-mcp@latest --port=' + DEBUG_PORT);
  console.log('');
  console.log('  Or add to Claude Code:');
  console.log('    claude mcp add chrome-devtools -- npx @anthropic-ai/chrome-devtools-mcp@latest --port=' + DEBUG_PORT);
  console.log('');
  console.log('  Theme options: --theme=dark (default) or --theme=light');
  console.log('');
  console.log('  Message log available in browser console as _mockMessageLog');
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('======================================================================');

  // -----------------------------------------------------------------------
  // 5. Handle cleanup
  // -----------------------------------------------------------------------
  var exiting = false;

  function cleanup(signal) {
    if (exiting) { return; }
    exiting = true;
    console.log('');
    console.log('  Received ' + signal + '. Shutting down...');

    server.close();

    // Kill Chrome if we launched it
    if (chromeInfo && chromeInfo.process) {
      try {
        if (process.platform === 'win32') {
          childProcess.spawn('taskkill', ['/pid', String(chromeInfo.process.pid), '/T', '/F'], {
            shell: true,
            stdio: 'ignore'
          });
        } else {
          chromeInfo.process.kill('SIGTERM');
        }
      } catch (_e) {
        // ignore
      }
    }

    // Clean up Chrome temp directory
    if (chromeInfo && chromeInfo.tempDir) {
      try {
        fs.rmSync(chromeInfo.tempDir, { recursive: true, force: true });
        console.log('  Cleaned up Chrome temp dir: ' + chromeInfo.tempDir);
      } catch (_e) {
        // ignore - Chrome may still have files locked
      }
    }

    setTimeout(function() { process.exit(0); }, 500);
  }

  process.on('SIGINT', function() { cleanup('SIGINT'); });
  process.on('SIGTERM', function() { cleanup('SIGTERM'); });
}

main().catch(function(err) {
  console.error('Fatal error:', err);
  process.exit(1);
});
