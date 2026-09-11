import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DaemonBeadsAdapter } from "./daemonBeadsAdapter";
import { getWebviewHtml } from "./webview";
import { sanitizeErrorWithContext as sanitizeError } from "./sanitizeError";
import { validateMarkdownFields, validateCommentContent } from "./markdownValidator";
import {
  BEADS_DIR,
  BEADS_MARKER_ENTRIES,
  REPO_PATH_STATE_KEY,
  BeadsResolution,
  resolveBeadsRoot,
  describeResolution
} from "./beadsWorkspace";
import { BEADS_WATCH_PATTERNS, shouldTriggerRefresh } from "./beadsWatch";
import {
  BoardData,
  BoardCard,
  MinimalCard,
  FullCard,
  BoardColumnKey,
  IssueStatus,
  describeValidationError,
  IssueUpdateSchema,
  IssueCreateSchema,
  CommentAddSchema,
  LabelSchema,
  DependencySchema,
  SetStatusSchema,
  BoardLoadColumnSchema,
  BoardLoadMoreSchema,
  TableLoadPageSchema,
  UIStateSchema,
  UIState,
  migrateUIState,
  ColumnDataMap,
  ColumnData,
  IssueIdSchema
} from "./types";

type WebMsg =
  | { type: "board.load"; requestId: string }
  | { type: "board.refresh"; requestId: string }
  | { type: "board.loadMinimal"; requestId: string }
  | { type: "board.loadColumn"; requestId: string; payload: { column: BoardColumnKey; offset: number; limit: number } }
  | { type: "board.loadMore"; requestId: string; payload: { column: BoardColumnKey } }
  | { type: "table.loadPage"; requestId: string; payload: { filters: { search?: string; priority?: string; type?: string; status?: string; assignee?: string; labels?: string[] }; sorting: Array<{ id: string; dir: 'asc' | 'desc' }>; offset: number; limit: number } }
  | { type: "repo.select"; requestId: string }
  | { type: "issue.create"; requestId: string; payload: { title: string; description?: string } }
  | { type: "issue.move"; requestId: string; payload: { id: string; toColumn: BoardColumnKey } }
  | { type: "issue.getFull"; requestId: string; payload: { id: string } }
  | { type: "issue.addToChat"; requestId: string; payload: { text: string } }
  | { type: "issue.copyToClipboard"; requestId: string; payload: { text: string } }
  | { type: "issue.update"; requestId: string; payload: { id: string; updates: unknown } }
  | { type: "issue.addComment"; requestId: string; payload: { id: string; text: string; author?: string } }
  | { type: "issue.addLabel"; requestId: string; payload: { id: string; label: string } }
  | { type: "issue.removeLabel"; requestId: string; payload: { id: string; label: string } }
  | { type: "issue.addDependency"; requestId: string; payload: { id: string; otherId: string; type: 'parent-child' | 'blocks' } }
  | { type: "issue.removeDependency"; requestId: string; payload: { id: string; otherId: string } }
  | { type: "state.uiState"; requestId: string; payload: UIState }
  | { type: "ui.confirmDiscard"; requestId: string };

type ExtMsg =
  | { type: "board.data"; requestId: string; payload: BoardData }
  | { type: "board.minimal"; requestId: string; payload: { cards: MinimalCard[]; uiState?: UIState } }
  | { type: "board.columnData"; requestId: string; payload: { column: BoardColumnKey; cards: BoardCard[]; offset: number; totalCount: number; hasMore: boolean } }
  | { type: "table.pageData"; requestId: string; payload: { cards: BoardCard[]; offset: number; totalCount: number; hasMore: boolean } }
  | { type: "issue.full"; requestId: string; payload: { card: FullCard } }
  | { type: "mutation.ok"; requestId: string; payload?: unknown }
  | { type: "ui.confirm.result"; requestId: string; payload: { confirmed: boolean } }
  | { type: "mutation.error"; requestId: string; error: string };

// Size limits for text operations
const MAX_CHAT_TEXT = 50_000; // 50KB reasonable for chat
const MAX_CLIPBOARD_TEXT = 100_000; // 100KB for clipboard

// Sanitize error messages to prevent leaking implementation details
// sanitizeError is now imported from ./sanitizeError

/**
 * Sanitizes text for CSV injection attacks.
 * Uses OWASP-recommended double-quote escaping: https://owasp.org/www-community/attacks/CSV_Injection
 *
 * Defense layers:
 * 1. Strip control characters (prevents tab-prefixed formulas)
 * 2. Prefix dangerous start characters with single quote (defense-in-depth)
 * 3. Wrap entire field in double quotes with proper CSV escaping (standard approach)
 *
 * @param text - The text to sanitize
 * @returns Sanitized text safe for clipboard/CSV
 */
function sanitizeForCSV(text: string): string {
  if (!text || text.length === 0) {
    return '""'; // Empty cells should still be quoted
  }

  // Replace control characters (including tabs, newlines, null bytes) with spaces
  // This prevents cell splitting and tab-prefixed formula injection
  // eslint-disable-next-line no-control-regex
  let sanitized = text.replace(/[\x00-\x1F\x7F]/g, ' ');

  // Check for formula-triggering characters at start: =, +, -, @, |, whitespace
  // Note: Pipe (|) is used in some CSV injection techniques
  const dangerousStart = /^[\s=+\-@|]/;

  if (dangerousStart.test(sanitized)) {
    // Prefix with single quote as an additional defense layer
    sanitized = "'" + sanitized;
  }

  // Standard CSV escaping: wrap in double quotes and escape internal quotes by doubling them
  // This is the OWASP-recommended approach and universally supported by CSV parsers
  sanitized = sanitized.replace(/"/g, '""');
  sanitized = '"' + sanitized + '"';

  return sanitized;
}

/**
 * Validates markdown content in all cards before sending to webview.
 * Logs warnings for suspicious content but does not block sending.
 * This is a defense-in-depth measure - webview still uses DOMPurify.
 * Async and chunked to prevent blocking the event loop on large datasets.
 */
async function validateBoardCards(cards: BoardCard[], output: vscode.OutputChannel): Promise<void> {
  const CHUNK_SIZE = 50;
  for (let i = 0; i < cards.length; i += CHUNK_SIZE) {
    const chunk = cards.slice(i, i + CHUNK_SIZE);
    
    // Process chunk synchronously
    for (const card of chunk) {
      validateMarkdownFields({
        description: card.description,
        acceptance_criteria: card.acceptance_criteria,
        design: card.design,
        notes: card.notes
      }, output);
    }
    
    // Yield to event loop to prevent freezing UI
    if (i + CHUNK_SIZE < cards.length) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Beads Kanban");
  output.appendLine('[BeadsAdapter] Environment Versions: ' + JSON.stringify(process.versions, null, 2));

  context.subscriptions.push(output);

  let adapter: DaemonBeadsAdapter | null = null;
  let adapterWorkspaceRoot: string | null = null;
  let lastDescribedResolution: string | null = null;

  const hasBeadsDir = (repoRoot: string): boolean => {
    const beadsDir = path.join(repoRoot, BEADS_DIR);
    try {
      if (!fs.statSync(beadsDir).isDirectory()) {
        return false;
      }
    } catch {
      return false;
    }
    return BEADS_MARKER_ENTRIES.some((entry) => fs.existsSync(path.join(beadsDir, entry)));
  };

  const resolveRoot = (): BeadsResolution => {
    const persisted = context.workspaceState.get<string>(REPO_PATH_STATE_KEY);
    const resolution = resolveBeadsRoot({
      roots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      persisted,
      hasBeadsDir,
      homeDir: os.homedir()
    });

    // A picked repository that has since moved or been deleted would otherwise
    // keep losing the race against discovery on every future session.
    if (persisted && resolution.kind !== 'persisted') {
      output.appendLine(`[Extension] Selected repository is no longer a Beads repository; clearing it.`);
      void context.workspaceState.update(REPO_PATH_STATE_KEY, undefined);
    }

    const described = describeResolution(resolution);
    if (described !== lastDescribedResolution) {
      output.appendLine(`[Extension] ${described}`);
      lastDescribedResolution = described;
    }

    return resolution;
  };

  const ensureAdapter = (): DaemonBeadsAdapter | null => {
    const resolution = resolveRoot();
    if (!resolution.root) {
      return null;
    }

    if (!adapter || adapterWorkspaceRoot !== resolution.root) {
      adapter?.dispose();
      output.appendLine('[Extension] Using DaemonBeadsAdapter');
      adapter = new DaemonBeadsAdapter(resolution.root, output);
      adapterWorkspaceRoot = resolution.root;
    }

    return adapter;
  };

  context.subscriptions.push({ dispose: () => adapter?.dispose() });

  // Set by an open board so a repository switch can rebind its file watchers,
  // which would otherwise stay pointed at the previous repository.
  let rebindWatchers: ((root: string) => void) | null = null;

  // Companion to rebindWatchers: retargeting the adapter leaves an open board
  // showing the previous repository's cards, and only the panel can re-send them.
  let reloadBoard: (() => void) | null = null;

  /**
   * Prompt for a folder containing `.beads`, persist it, and retarget the
   * adapter. Returns the chosen path, or null if the user cancelled or picked
   * a folder without a `.beads` directory.
   */
  const selectBeadsRepository = async (): Promise<string | null> => {
    const selectedFolder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Select Beads Repository Folder",
      title: `Select a folder containing a ${BEADS_DIR} directory`
    });

    if (!selectedFolder || !selectedFolder[0]) {
      return null;
    }

    const folderPath = selectedFolder[0].fsPath;
    if (!hasBeadsDir(folderPath)) {
      vscode.window.showErrorMessage(
        `Selected folder does not contain a Beads repository. Run 'bd init' there, or pick the folder whose ${BEADS_DIR} directory holds the issue database.`
      );
      return null;
    }

    // Persisted so the choice survives a window reload; resolveBeadsRoot gives
    // it precedence over discovery.
    await context.workspaceState.update(REPO_PATH_STATE_KEY, folderPath);
    lastDescribedResolution = null;

    // Retarget the existing adapter in place rather than going through
    // ensureAdapter(): recreating it here would leave an open board holding a
    // disposed instance. If no adapter exists yet, the next ensureAdapter()
    // call builds one at the newly persisted root.
    adapter?.setWorkspaceRoot(folderPath);
    adapterWorkspaceRoot = folderPath;
    rebindWatchers?.(folderPath);

    vscode.window.showInformationMessage(`Switched to repository: ${folderPath}`);
    return folderPath;
  };

  ensureAdapter();

  // A multi-root window can register its second root after activation, and
  // folders can be added or removed at any point in a session. Nothing else
  // re-resolves for a board that is already open.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const resolution = resolveRoot();
      if (!resolution.root || resolution.root === adapterWorkspaceRoot) {
        return;
      }

      if (!adapter) {
        ensureAdapter();
        return;
      }

      // Retargeted in place: ensureAdapter() disposes, and an open board holds
      // this instance.
      adapter.setWorkspaceRoot(resolution.root);
      adapterWorkspaceRoot = resolution.root;
      rebindWatchers?.(resolution.root);
      reloadBoard?.();
    })
  );

  const openCmd = vscode.commands.registerCommand("beadsKanban.openBoard", async () => {
    const resolution = resolveRoot();
    if (!resolution.root) {
      vscode.window.showErrorMessage('Beads Kanban requires an open workspace folder.');
      return;
    }

    const adapter = ensureAdapter();
    if (!adapter) {
      vscode.window.showErrorMessage('Beads Kanban requires an open workspace folder.');
      return;
    }

    // Surface an ambiguous or failed lookup without blocking activation.
    if (resolution.kind === 'none') {
      void vscode.window.showWarningMessage(
        `No Beads repository was found in this workspace. Using ${resolution.root}, where bd commands will fail until one exists.`,
        'Select Repository Folder…'
      ).then((choice) => {
        if (choice) { void selectBeadsRepository(); }
      });
    } else if (resolution.kind === 'direct' && resolution.candidates.length > 1) {
      void vscode.window.showInformationMessage(
        `Several workspace roots contain a ${BEADS_DIR} directory. Using ${resolution.root}.`,
        'Select Repository Folder…'
      ).then((choice) => {
        if (choice) { void selectBeadsRepository(); }
      });
    }

    try {
      output.appendLine('[Extension] === Opening Beads Kanban Board ===');
      output.appendLine('[Extension] Creating webview panel...');
    const panel = vscode.window.createWebviewPanel(
      "beadsKanban.board",
      "Beads Kanban",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );
    output.appendLine('[Extension] Webview panel created');

    const readOnly = vscode.workspace.getConfiguration().get<boolean>("beadsKanban.readOnly", false);

    // Track disposal state and initial load
    let isDisposed = false;
    let initialLoadSent = false;

    // Cancellation token for async operations to prevent posting after disposal
    // This prevents the race condition between checking isDisposed and calling postMessage
    const cancellationToken = { cancelled: false };

    // Track loaded ranges per column for incremental loading
    const loadedRanges = new Map<BoardColumnKey, Array<{ offset: number; limit: number }>>();
    // Initialize with empty arrays for each column
    loadedRanges.set('ready', []);
    loadedRanges.set('in_progress', []);
    loadedRanges.set('blocked', []);
    loadedRanges.set('closed', []);

    const post = (msg: ExtMsg) => {
      // Atomic check for disposal and cancellation to prevent TOCTOU race condition
      if (isDisposed || cancellationToken.cancelled) {
        output.appendLine(`[Extension] Attempted to post to disposed/cancelled webview: ${msg.type}`);
        return;
      }
      try {
        // Additional check for panel disposal to prevent race conditions
        if (!panel || !panel.webview) {
          output.appendLine(`[Extension] Panel disposed before posting ${msg.type}`);
          isDisposed = true;
          return;
        }
        panel.webview.postMessage(msg);
      } catch (e) {
        output.appendLine(`[Extension] Error posting message: ${sanitizeError(e)}`);
        isDisposed = true; // Mark as disposed if posting fails
      }
    };

    // Read persisted UI state (sort, filters, view mode, etc.) from
    // workspaceState. Returns undefined on first run or if a corrupted payload
    // (e.g., from a future build) fails validation — board loads stay
    // unblocked rather than throwing on a malformed stored value.
    const readPersistedUIState = (): UIState | undefined => {
      const raw = context.workspaceState.get('beadsKanban.uiState');
      if (raw === undefined) { return undefined; }
      const migrated = migrateUIState(raw);
      const parsed = UIStateSchema.safeParse(migrated);
      if (!parsed.success) {
        output.appendLine(`[Extension] Discarding invalid persisted UI state: ${parsed.error.message}`);
        return undefined;
      }
      return parsed.data;
    };

    const sendBoard = async (requestId: string) => {
      if (isDisposed) {
        output.appendLine(`[Extension] Skipping sendBoard - webview is disposed`);
        return;
      }
      output.appendLine(`[Extension] sendBoard called with requestId: ${requestId}`);
      initialLoadSent = true; // Mark that we've sent board data
      try {
        // Read configuration settings
        const config = vscode.workspace.getConfiguration('beadsKanban');
        const initialLoadLimit = config.get<number>('initialLoadLimit', 100);

        // Phase 1-3: Prefer fast minimal loading if available
        const supportsFastLoading = typeof (adapter as DaemonBeadsAdapter).getBoardMinimal === 'function';

        if (supportsFastLoading) {
          output.appendLine(`[Extension] Using fast loading path (getBoardMinimal) with limit: ${initialLoadLimit}`);
          const cards = await (adapter as DaemonBeadsAdapter).getBoardMinimal(initialLoadLimit);
          output.appendLine(`[Extension] Loaded ${cards.length} minimal cards for refresh`);

          // Check cancellation before posting
          if (!cancellationToken.cancelled) {
            const uiState = readPersistedUIState();
            post({ type: "board.minimal", requestId, payload: uiState ? { cards, uiState } : { cards } });
          } else {
            output.appendLine(`[Extension] Skipped posting board.minimal - operation cancelled`);
          }
          return;
        }

        // Fallback: Use incremental loading
        const preloadClosedColumn = config.get<boolean>('preloadClosedColumn', false);

        output.appendLine(`[Extension] Using initialLoadLimit: ${initialLoadLimit}, preloadClosedColumn: ${preloadClosedColumn}`);

        // Check if adapter supports incremental loading
        const supportsIncremental = typeof adapter.getColumnData === 'function' && typeof adapter.getColumnCount === 'function';

        if (supportsIncremental) {
          // Use incremental loading approach
          output.appendLine(`[Extension] Using incremental loading for initial board data`);

          const columnsToPreload: BoardColumnKey[] = ['ready', 'in_progress', 'blocked'];
          if (preloadClosedColumn) {
            columnsToPreload.push('closed');
          }

          // Load initial data for each column using proper types
          // Initialize all columns to satisfy ColumnDataMap type
          const columnDataMap = {} as ColumnDataMap;

          // Initialize 'open' column with empty data (not displayed in UI)
          const openTotalCount = await adapter.getColumnCount('open');
          columnDataMap['open'] = {
            cards: [],
            offset: 0,
            limit: 0,
            totalCount: openTotalCount,
            hasMore: openTotalCount > 0
          };

          for (const column of columnsToPreload) {
            try {
              const cards = await adapter.getColumnData(column, 0, initialLoadLimit);
              const totalCount = await adapter.getColumnCount(column);
              const hasMore = initialLoadLimit < totalCount;

              const columnData: ColumnData = {
                cards,
                offset: 0,
                limit: initialLoadLimit,
                totalCount,
                hasMore
              };
              columnDataMap[column] = columnData;

              // Track loaded range
              const ranges = loadedRanges.get(column) || [];
              ranges.push({ offset: 0, limit: initialLoadLimit });
              loadedRanges.set(column, ranges);

              output.appendLine(`[Extension] Loaded ${cards.length}/${totalCount} cards for column ${column}`);
            } catch (columnError) {
              output.appendLine(`[Extension] Error loading column ${column}: ${sanitizeError(columnError)}`);
              // Initialize with empty data on error
              const emptyColumnData: ColumnData = {
                cards: [],
                offset: 0,
                limit: initialLoadLimit,
                totalCount: 0,
                hasMore: false
              };
              columnDataMap[column] = emptyColumnData;
            }
          }

          // Initialize closed column with empty data if not preloaded
          if (!preloadClosedColumn) {
            const totalCount = await adapter.getColumnCount('closed');
            const closedColumnData: ColumnData = {
              cards: [],
              offset: 0,
              limit: 0,
              totalCount,
              hasMore: totalCount > 0
            };
            columnDataMap['closed'] = closedColumnData;
            output.appendLine(`[Extension] Closed column not preloaded (${totalCount} total cards available)`);
          }

          // Use getBoardMetadata() instead of getBoard() to avoid loading all issues
          const data = await adapter.getBoardMetadata();
          data.columnData = columnDataMap;
          data.readOnly = readOnly; // Propagate read-only mode to webview UI
          const persistedUIState = readPersistedUIState();
          if (persistedUIState) { data.uiState = persistedUIState; }

          // Validate markdown content in column cards (defense-in-depth)
          // Note: data.cards is now empty array from getBoardMetadata, actual cards are in columnData
          // Also validate cards in columnData
          for (const column of Object.keys(columnDataMap)) {
            const columnCards = columnDataMap[column as BoardColumnKey]?.cards;
            if (columnCards && columnCards.length > 0) {
              await validateBoardCards(columnCards, output);
            }
          }

          output.appendLine(`[Extension] Sending incremental board data with columnData`);
          // Check cancellation before posting to prevent race with disposal
          if (!cancellationToken.cancelled) {
            post({ type: "board.data", requestId, payload: data });
          } else {
            output.appendLine(`[Extension] Skipped posting board.data - operation cancelled`);
          }
        } else {
          // Fallback to legacy full load
          output.appendLine(`[Extension] Adapter does not support incremental loading, using legacy getBoard()`);
          const data = await adapter.getBoard();
          data.readOnly = readOnly; // Propagate read-only mode to webview UI
          const persistedUIState = readPersistedUIState();
          if (persistedUIState) { data.uiState = persistedUIState; }
          output.appendLine(`[Extension] Got board data: ${data.cards?.length || 0} cards`);

          // Validate markdown content in all cards (defense-in-depth)
          await validateBoardCards(data.cards || [], output);
          // Check cancellation before posting to prevent race with disposal
          if (!cancellationToken.cancelled) {
            post({ type: "board.data", requestId, payload: data });
          } else {
            output.appendLine(`[Extension] Skipped posting board.data - operation cancelled`);
          }
        }

        output.appendLine(`[Extension] Posted board.data message`);
      } catch (e) {
        output.appendLine(`[Extension] Error in sendBoard: ${sanitizeError(e)}`);
        // Check both disposal flag and cancellation token
        if (!isDisposed && !cancellationToken.cancelled) {
          post({ type: "mutation.error", requestId, error: sanitizeError(e) });
        }
      }
    };

    const handleLoadColumn = async (requestId: string, column: BoardColumnKey, offset: number, limit: number) => {
      if (isDisposed) {
        output.appendLine(`[Extension] Skipping handleLoadColumn - webview is disposed`);
        return;
      }
      output.appendLine(`[Extension] handleLoadColumn: column=${column}, offset=${offset}, limit=${limit}`);
      
      try {
        // Validate the request
        const validation = BoardLoadColumnSchema.safeParse({ column, offset, limit });
        if (!validation.success) {
          post({ type: "mutation.error", requestId, error: `Invalid loadColumn request: ${describeValidationError(validation.error)}` });
          return;
        }

        // Load the column data
        const cards = await adapter.getColumnData(column, offset, limit);
        const totalCount = await adapter.getColumnCount(column);
        const hasMore = (offset + cards.length) < totalCount;

        // Track loaded range
        const ranges = loadedRanges.get(column) || [];
        ranges.push({ offset, limit });
        loadedRanges.set(column, ranges);

        output.appendLine(`[Extension] Loaded ${cards.length} cards for column ${column} (${offset}-${offset + cards.length}/${totalCount})`);

        // Send response - check cancellation before posting
        if (!cancellationToken.cancelled) {
          post({
            type: 'board.columnData',
            requestId,
            payload: { column, cards, offset, totalCount, hasMore }
          });
        } else {
          output.appendLine(`[Extension] Skipped posting board.columnData - operation cancelled`);
        }
      } catch (e) {
        output.appendLine(`[Extension] Error in handleLoadColumn: ${sanitizeError(e)}`);
        // Check both disposal flag and cancellation token
        if (!isDisposed && !cancellationToken.cancelled) {
          post({ type: "mutation.error", requestId, error: sanitizeError(e) });
        }
      }
    };

    const handleLoadMore = async (requestId: string, column: BoardColumnKey) => {
      if (isDisposed) {
        output.appendLine(`[Extension] Skipping handleLoadMore - webview is disposed`);
        return;
      }
      output.appendLine(`[Extension] handleLoadMore: column=${column}`);

      try {
        // Validate the request
        const validation = BoardLoadMoreSchema.safeParse({ column });
        if (!validation.success) {
          // Check cancellation before posting error
          if (!cancellationToken.cancelled) {
            post({ type: "mutation.error", requestId, error: `Invalid loadMore request: ${describeValidationError(validation.error)}` });
          }
          return;
        }

        // Calculate next offset from loadedRanges
        const ranges = loadedRanges.get(column) || [];
        const nextOffset = ranges.reduce((max, r) => Math.max(max, r.offset + r.limit), 0);

        // Use configured pageSize
        const pageSize = vscode.workspace.getConfiguration('beadsKanban').get<number>('pageSize', 50);

        output.appendLine(`[Extension] Loading more for column ${column} from offset ${nextOffset} with pageSize ${pageSize}`);

        // Delegate to handleLoadColumn logic
        await handleLoadColumn(requestId, column, nextOffset, pageSize);
      } catch (e) {
        output.appendLine(`[Extension] Error in handleLoadMore: ${sanitizeError(e)}`);
        // Check both disposal flag and cancellation token
        if (!isDisposed && !cancellationToken.cancelled) {
          post({ type: "mutation.error", requestId, error: sanitizeError(e) });
        }
      }
    };

    const handleTableLoadPage = async (
      requestId: string,
      filters: { search?: string; priority?: string; type?: string; status?: string; assignee?: string; labels?: string[] },
      sorting: Array<{ id: string; dir: 'asc' | 'desc' }>,
      offset: number,
      limit: number
    ) => {
      if (isDisposed) {
        output.appendLine(`[Extension] Skipping handleTableLoadPage - webview is disposed`);
        return;
      }
      output.appendLine(`[Extension] handleTableLoadPage: offset=${offset}, limit=${limit}, filters=${JSON.stringify(filters)}, sorting=${JSON.stringify(sorting)}`);

      try {
        // Call adapter's getTableData method
        const result = await adapter.getTableData(filters, sorting, offset, limit);

        // Validate markdown content in returned cards (defense-in-depth)
        await validateBoardCards(result.cards, output);

        output.appendLine(`[Extension] Loaded ${result.cards.length} cards for table (${offset}-${offset + result.cards.length}/${result.totalCount})`);

        // Send response - check cancellation before posting
        if (!cancellationToken.cancelled) {
          post({
            type: 'table.pageData',
            requestId,
            payload: { 
              cards: result.cards, 
              offset, 
              totalCount: result.totalCount,
              hasMore: (offset + result.cards.length) < result.totalCount
            }
          });
        } else {
          output.appendLine(`[Extension] Skipped posting table.pageData - operation cancelled`);
        }
      } catch (e) {
        output.appendLine(`[Extension] Error in handleTableLoadPage: ${sanitizeError(e)}`);
        // Check both disposal flag and cancellation token
        if (!isDisposed && !cancellationToken.cancelled) {
          post({ type: "mutation.error", requestId, error: sanitizeError(e) });
        }
      }
    };

    // Set up message handler BEFORE setting HTML to avoid race condition
    panel.webview.onDidReceiveMessage(async (msg: WebMsg) => {
      output.appendLine(`[Extension] Received message: ${msg?.type} (requestId: ${msg?.requestId})`);
      if (!msg?.type || !msg.requestId) {return;}

      if (msg.type === "board.load" || msg.type === "board.refresh") {
        sendBoard(msg.requestId);
        return;
      }

      if (msg.type === "state.uiState") {
        try {
          const validation = UIStateSchema.safeParse(msg.payload);
          if (!validation.success) {
            post({ type: "mutation.error", requestId: msg.requestId, error: `Invalid UI state: ${describeValidationError(validation.error)}` });
            return;
          }
          await context.workspaceState.update('beadsKanban.uiState', validation.data);
          post({ type: "mutation.ok", requestId: msg.requestId });
        } catch (e) {
          output.appendLine(`[Extension] Error persisting UI state: ${sanitizeError(e)}`);
          if (!isDisposed && !cancellationToken.cancelled) {
            post({ type: "mutation.error", requestId: msg.requestId, error: sanitizeError(e) });
          }
        }
        return;
      }

      if (msg.type === "board.loadColumn") {
        const { column, offset, limit } = msg.payload;
        await handleLoadColumn(msg.requestId, column, offset, limit);
        return;
      }

      if (msg.type === "board.loadMore") {
        const { column } = msg.payload;
        await handleLoadMore(msg.requestId, column);
        return;
      }

      if (msg.type === "board.loadMinimal") {
        try {
          // Check if adapter supports fast loading
          if (typeof (adapter as DaemonBeadsAdapter).getBoardMinimal !== 'function') {
            post({ type: "mutation.error", requestId: msg.requestId, error: "Adapter does not support fast minimal loading. Please enable daemon mode or update your adapter." });
            return;
          }

          // Read config to get limit
          const config = vscode.workspace.getConfiguration('beadsKanban');
          const initialLoadLimit = config.get<number>('initialLoadLimit', 100);

          output.appendLine(`[Extension] Loading minimal board data with limit: ${initialLoadLimit}`);
          const cards = await (adapter as DaemonBeadsAdapter).getBoardMinimal(initialLoadLimit);
          output.appendLine(`[Extension] Loaded ${cards.length} minimal cards`);
          
          // Check cancellation before posting
          if (!cancellationToken.cancelled) {
            const uiState = readPersistedUIState();
            post({ type: "board.minimal", requestId: msg.requestId, payload: uiState ? { cards, uiState } : { cards } });
          } else {
            output.appendLine(`[Extension] Skipped posting board.minimal - operation cancelled`);
          }
        } catch (e) {
          output.appendLine(`[Extension] Error loading minimal board: ${sanitizeError(e)}`);
          if (!isDisposed && !cancellationToken.cancelled) {
            post({ type: "mutation.error", requestId: msg.requestId, error: sanitizeError(e) });
          }
        }
        return;
      }

      if (msg.type === "issue.getFull") {
        try {
          const issueId = msg.payload.id;

          // Validate issue ID using same schema as adapter
          const validation = IssueIdSchema.safeParse(issueId);
          if (!validation.success) {
            post({ type: "mutation.error", requestId: msg.requestId, error: "Invalid issue ID format" });
            return;
          }
          
          // Check if adapter supports fast loading
          if (typeof (adapter as DaemonBeadsAdapter).getIssueFull !== 'function') {
            post({ type: "mutation.error", requestId: msg.requestId, error: "Adapter does not support full issue loading. Please enable daemon mode or update your adapter." });
            return;
          }
          
          output.appendLine(`[Extension] Loading full details for issue ${issueId}`);
          const card = await (adapter as DaemonBeadsAdapter).getIssueFull(issueId);
          output.appendLine(`[Extension] Loaded full card for ${issueId}`);
          
          // Validate markdown content (defense-in-depth)
          const fullCardValid = validateMarkdownFields({
            description: card.description,
            acceptance_criteria: card.acceptance_criteria,
            design: card.design,
            notes: card.notes
          }, output);
          if (!fullCardValid) {
            output.appendLine(`[Extension] Warning: Suspicious content detected in full card ${issueId}`);
            // Log warning but allow return (defense-in-depth, not blocking)
          }
          
          // Check cancellation before posting
          if (!cancellationToken.cancelled) {
            post({ type: "issue.full", requestId: msg.requestId, payload: { card } });
          } else {
            output.appendLine(`[Extension] Skipped posting issue.full - operation cancelled`);
          }
        } catch (e) {
          output.appendLine(`[Extension] Error loading full issue: ${sanitizeError(e)}`);
          if (!isDisposed && !cancellationToken.cancelled) {
            post({ type: "mutation.error", requestId: msg.requestId, error: sanitizeError(e) });
          }
        }
        return;
      }

      if (msg.type === "table.loadPage") {
        const validation = TableLoadPageSchema.safeParse(msg.payload);
        if (!validation.success) {
          panel.webview.postMessage({ type: 'mutation.error', payload: { message: 'Invalid table load parameters' } });
          return;
        }
        const { filters = {}, sorting = [], offset = 0, limit = 100 } = validation.data;
        await handleTableLoadPage(msg.requestId, filters, sorting, offset, limit);
        return;
      }

      if (msg.type === "repo.select") {
        // The picker itself persists the choice, retargets the adapter and
        // rebinds the watchers; only the board reload is panel-specific.
        const folderPath = await selectBeadsRepository();

        if (!folderPath) {
          post({ type: "mutation.ok", requestId: msg.requestId });
          return;
        }

        try {
          const data = await adapter.getBoard();
          data.readOnly = readOnly; // Propagate read-only mode to webview UI
          const persistedUIState = readPersistedUIState();
          if (persistedUIState) { data.uiState = persistedUIState; }
          post({ type: "board.data", requestId: msg.requestId, payload: data });
        } catch (err) {
          output.appendLine(`[Extension] Error loading board after repo switch: ${sanitizeError(err)}`);
          post({ type: "mutation.error", requestId: msg.requestId, error: "Failed to load new repository" });
        }
        return;
      }

      if (readOnly) {
        post({ type: "mutation.error", requestId: msg.requestId, error: "Extension is in read-only mode." });
        return;
      }

      try {
        if (msg.type === "issue.create") {
          const validation = IssueCreateSchema.safeParse(msg.payload);
          if (!validation.success) {
            post({ type: "mutation.error", requestId: msg.requestId, error: `Invalid issue data: ${describeValidationError(validation.error)}` });
            return;
          }
          
          // Validate markdown content (defense-in-depth)
          const createValid = validateMarkdownFields({
            description: validation.data.description
          }, output);
          if (!createValid) {
            output.appendLine(`[Extension] BLOCKED: Suspicious content detected in new issue`);
            post({ type: "mutation.error", requestId: msg.requestId, error: "Content contains unsafe patterns (javascript:, <script>, or data:text/html)" });
            return;
          }
          
          const created = await adapter.createIssue(validation.data);
          post({ type: "mutation.ok", requestId: msg.requestId, payload: { id: created.id } });
          // push refreshed board
          await sendBoard(msg.requestId);
          return;
        }

        if (msg.type === "issue.move") {
          const toStatus: IssueStatus = mapColumnToStatus(msg.payload.toColumn);
          const validation = SetStatusSchema.safeParse({
            id: msg.payload.id,
            status: toStatus
          });
          if (!validation.success) {
            post({ type: "mutation.error", requestId: msg.requestId, error: `Invalid move data: ${describeValidationError(validation.error)}` });
            return;
          }
          await adapter.setIssueStatus(validation.data.id, validation.data.status);
          post({ type: "mutation.ok", requestId: msg.requestId });
          await sendBoard(msg.requestId);
          return;
        }

        if (msg.type === "issue.addToChat") {
          if (!msg.payload.text || msg.payload.text.length > MAX_CHAT_TEXT) {
            post({ type: "mutation.error", requestId: msg.requestId, error: `Text too large for chat (max ${MAX_CHAT_TEXT} characters)` });
            return;
          }
          vscode.commands.executeCommand("workbench.action.chat.open", { query: msg.payload.text });
          post({ type: "mutation.ok", requestId: msg.requestId });
          return;
        }

        if (msg.type === "issue.copyToClipboard") {
            if (!msg.payload.text || msg.payload.text.length > MAX_CLIPBOARD_TEXT) {
              post({ type: "mutation.error", requestId: msg.requestId, error: `Text too large for clipboard (max ${MAX_CLIPBOARD_TEXT} characters)` });
              return;
            }
            // Sanitize for CSV injection before copying to clipboard
            const sanitizedText = sanitizeForCSV(msg.payload.text);
            vscode.env.clipboard.writeText(sanitizedText);
            post({ type: "mutation.ok", requestId: msg.requestId });
            vscode.window.showInformationMessage("Issue context copied to clipboard.");
            return;
        }

        // The webview cannot prompt for itself: window.confirm is stubbed out in
        // VS Code webviews and returns false without showing anything, which made
        // the edit dialog's discard guard impossible to satisfy.
        if (msg.type === "ui.confirmDiscard") {
          const choice = await vscode.window.showWarningMessage(
            "Discard unsaved changes?",
            { modal: true },
            "Discard"
          );
          post({
            type: "ui.confirm.result",
            requestId: msg.requestId,
            payload: { confirmed: choice === "Discard" }
          });
          return;
        }

        if (msg.type === "issue.update") {
          const validation = IssueUpdateSchema.safeParse(msg.payload);
          if (!validation.success) {
            post({ type: "mutation.error", requestId: msg.requestId, error: `Invalid update data: ${describeValidationError(validation.error)}` });
            return;
          }
          
          // Validate markdown content in updates (defense-in-depth)
          const updateValid = validateMarkdownFields({
            description: validation.data.updates.description,
            acceptance_criteria: validation.data.updates.acceptance_criteria,
            design: validation.data.updates.design,
            notes: validation.data.updates.notes
          }, output);
          if (!updateValid) {
            output.appendLine(`[Extension] BLOCKED: Suspicious content detected in issue update`);
            post({ type: "mutation.error", requestId: msg.requestId, error: "Content contains unsafe patterns (javascript:, <script>, or data:text/html)" });
            return;
          }
          
          await adapter.updateIssue(validation.data.id, validation.data.updates);
          post({ type: "mutation.ok", requestId: msg.requestId });
          await sendBoard(msg.requestId);
          return;
        }

        if (msg.type === "issue.addComment") {
            // TODO: Attempt to get git user name or vs code user name?
            // For now, default to "Me" or let UI send it?
            // Let's use a simple default here if not provided.
            const author = msg.payload.author || "User";
            const validation = CommentAddSchema.safeParse({
              id: msg.payload.id,
              text: msg.payload.text,
              author
            });
            if (!validation.success) {
              post({ type: "mutation.error", requestId: msg.requestId, error: `Invalid comment data: ${describeValidationError(validation.error)}` });
              return;
            }
            
            // Validate comment markdown content (defense-in-depth)
            const commentValidation = validateCommentContent(validation.data.text, output);
            if (!commentValidation.isValid) {
              output.appendLine(`[Extension] BLOCKED: Suspicious content detected in comment`);
              post({ type: "mutation.error", requestId: msg.requestId, error: "Comment contains unsafe patterns (javascript:, <script>, or data:text/html)" });
              return;
            }
            
            await adapter.addComment(validation.data.id, validation.data.text, validation.data.author);
            post({ type: "mutation.ok", requestId: msg.requestId });
            await sendBoard(msg.requestId);
            return;
        }

        if (msg.type === "issue.addLabel") {
            const validation = LabelSchema.safeParse({
              id: msg.payload.id,
              label: msg.payload.label
            });
            if (!validation.success) {
              post({ type: "mutation.error", requestId: msg.requestId, error: `Invalid label data: ${describeValidationError(validation.error)}` });
              return;
            }
            await adapter.addLabel(validation.data.id, validation.data.label);
            post({ type: "mutation.ok", requestId: msg.requestId });
            await sendBoard(msg.requestId);
            return;
        }

        if (msg.type === "issue.removeLabel") {
            const validation = LabelSchema.safeParse({
              id: msg.payload.id,
              label: msg.payload.label
            });
            if (!validation.success) {
              post({ type: "mutation.error", requestId: msg.requestId, error: `Invalid label data: ${describeValidationError(validation.error)}` });
              return;
            }
            await adapter.removeLabel(validation.data.id, validation.data.label);
            post({ type: "mutation.ok", requestId: msg.requestId });
            await sendBoard(msg.requestId);
            return;
        }

        if (msg.type === "issue.addDependency") {
            const validation = DependencySchema.safeParse({
              id: msg.payload.id,
              otherId: msg.payload.otherId,
              type: msg.payload.type
            });
            if (!validation.success) {
              post({ type: "mutation.error", requestId: msg.requestId, error: `Invalid dependency data: ${describeValidationError(validation.error)}` });
              return;
            }
            await adapter.addDependency(validation.data.id, validation.data.otherId, validation.data.type);
            post({ type: "mutation.ok", requestId: msg.requestId });
            await sendBoard(msg.requestId);
            return;
        }

        if (msg.type === "issue.removeDependency") {
            const validation = DependencySchema.safeParse({
              id: msg.payload.id,
              otherId: msg.payload.otherId
            });
            if (!validation.success) {
              post({ type: "mutation.error", requestId: msg.requestId, error: `Invalid dependency data: ${describeValidationError(validation.error)}` });
              return;
            }
            await adapter.removeDependency(validation.data.id, validation.data.otherId);
            post({ type: "mutation.ok", requestId: msg.requestId });
            await sendBoard(msg.requestId);
            return;
        }

        post({ type: "mutation.error", requestId: (msg as { requestId: string; type: string }).requestId, error: `Unknown message type: ${(msg as { type: string }).type}` });
      } catch (e) {
        post({
          type: "mutation.error",
          requestId: msg.requestId,
          error: sanitizeError(e)
        });
      }
    });

    // Set HTML after message handler is ready to avoid race condition
    output.appendLine('[Extension] Setting webview HTML');
    try {
      panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri);
      output.appendLine('[Extension] Webview HTML set successfully');
    } catch (e) {
      output.appendLine(`[Extension] Error setting webview HTML: ${sanitizeError(e)}`);
      isDisposed = true;
      return;
    }

    // Auto refresh when the Beads database changes
    const watchedRoot = resolution.root;
    if (watchedRoot) {
      let watchers: vscode.FileSystemWatcher[] = [];
      let refreshTimeout: NodeJS.Timeout | null = null;
      let changeCount = 0; // Track changes during debounce window
      const refresh = (uri?: vscode.Uri) => {
        // Ignore locks, logs and journals, which churn without any issue changing
        if (uri && !shouldTriggerRefresh(uri.fsPath)) {
          return;
        }

        // Log what triggered the refresh
        if (uri) {
          output.appendLine(`[Extension] File changed: ${uri.fsPath}`);
        } else {
          output.appendLine(`[Extension] File changed (unknown URI)`);
        }

        // Skip refresh if this change is from our own save operation
        if (adapter.isRecentSelfSave()) {
          output.appendLine(`[Extension] Ignoring change due to recent self-save/interaction`);
          return;
        }

        // Track rapid changes for monitoring
        changeCount++;
        if (changeCount > 3) {
          output.appendLine(`[Extension] Warning: ${changeCount} rapid file changes detected in debounce window. This may indicate external tool making frequent DB updates. Consider increasing debounce delay if you see stale data.`);
        }

        if (refreshTimeout) {
          clearTimeout(refreshTimeout);
        }
        refreshTimeout = setTimeout(async () => {
          // Check disposal before starting async operations
          if (isDisposed || cancellationToken.cancelled) {
            output.appendLine('[Extension] Skipping file watcher refresh - panel disposed');
            return;
          }

          try {
            // Reload database from disk to pick up external changes
            await adapter.reloadDatabase();

            // Check disposal again after async operation
            if (isDisposed || cancellationToken.cancelled) {
              output.appendLine('[Extension] Skipping sendBoard - panel disposed during reload');
              return;
            }

            const requestId = `fs-${Date.now()}`;
            sendBoard(requestId);
          } catch (error) {
            const errorMsg = `Failed to reload database: ${sanitizeError(error)}`;

            // Check disposal before posting error
            if (!isDisposed && !cancellationToken.cancelled) {
              // Send error to webview using post() for safety
              post({
                type: "mutation.error",
                requestId: `fs-error-${Date.now()}`,
                error: errorMsg
              });

              // Show warning to user so they know auto-refresh is broken
              vscode.window.showWarningMessage(
                `Beads auto-refresh failed: ${errorMsg}. Use the Refresh button to try again.`
              );
            }
          }
          // Reset change tracking after refresh completes
          changeCount = 0;
          refreshTimeout = null;
        }, 300);
      };
      // A Uri base rather than a WorkspaceFolder: with a persisted picker choice
      // or an ancestor match the root can be outside every workspace folder,
      // which a WorkspaceFolder-relative pattern cannot express.
      const attachWatchers = (root: string) => {
        for (const existing of watchers) {
          existing.dispose();
        }
        watchers = BEADS_WATCH_PATTERNS.map((pattern) => {
          const created = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(root), pattern)
          );
          created.onDidChange(refresh);
          created.onDidCreate(refresh);
          created.onDidDelete(refresh);
          return created;
        });
        output.appendLine(`[Extension] Watching ${BEADS_WATCH_PATTERNS.length} patterns under ${root}`);
      };

      attachWatchers(watchedRoot);
      rebindWatchers = attachWatchers;

      const resendBoard = () => {
        output.appendLine('[Extension] Repository changed; reloading board');
        void sendBoard(`root-${Date.now()}`);
      };
      reloadBoard = resendBoard;

      panel.onDidDispose(() => {
        output.appendLine('[Extension] Panel disposed');
        isDisposed = true;

        // Cancel all pending async operations to prevent posting after disposal
        cancellationToken.cancelled = true;

        // Try to send cleanup message to webview before disposal
        try {
          panel.webview.postMessage({ type: 'webview.cleanup' });
        } catch {
          // Webview already disposed, ignore
        }

        // Clear loaded ranges tracking
        loadedRanges.clear();

        if (refreshTimeout) {
          clearTimeout(refreshTimeout);
        }
        // Only clear the slot if it is still ours; a second board opened later
        // will have replaced it and is still using it.
        if (rebindWatchers === attachWatchers) {
          rebindWatchers = null;
        }
        if (reloadBoard === resendBoard) {
          reloadBoard = null;
        }
        for (const existing of watchers) {
          existing.dispose();
        }
        watchers = [];
      });
    }

    // initial load - give webview time to initialize (safety net)
    // Skip if webview already requested the initial load
    output.appendLine('[Extension] Triggering initial board load timeout');
    setTimeout(() => {
      if (isDisposed) {
        output.appendLine('[Extension] Panel disposed before initial load timeout');
      } else if (initialLoadSent) {
        output.appendLine('[Extension] Skipping timeout load - webview already loaded');
      } else {
        output.appendLine('[Extension] Sending initial board data from timeout');
        sendBoard(`init-${Date.now()}`);
      }
    }, 500);
    } catch (error) {
      output.appendLine(`[Extension] Error in openBoard command: ${sanitizeError(error)}`);
      vscode.window.showErrorMessage(`Failed to open Beads Kanban: ${sanitizeError(error)}`);
    }
  });

  context.subscriptions.push(openCmd);
}

export function deactivate() {
  // nothing
}

function mapColumnToStatus(col: BoardColumnKey): IssueStatus {
  // Map column keys to issue statuses
  // Ready is derived from `ready_issues` view; status is still "open"
  const mapping: Record<BoardColumnKey, IssueStatus> = {
    ready: "open",
    open: "open",
    in_progress: "in_progress",
    blocked: "blocked",
    closed: "closed"
  };

  const status = mapping[col];
  if (!status) {
    throw new Error(`Invalid column: ${col}`);
  }
  return status;
}
