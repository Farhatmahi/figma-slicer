// Open above the 840 px split-layout breakpoint so v12 is visible on launch.
figma.showUI(__html__, { width: 1100, height: 840, themeColors: true });

type Region = {
  id: string;
  sectionIndex: number;
  columnIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  filename: string;
};

type LayerBounds = { x: number; y: number; width: number; height: number };

type TextItem = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type ExportRequest = {
  type: 'EXPORT';
  horizontalCuts: number[];
  verticalCutsBySection: Record<string, number[]>;
  excludeAfterLastCut: boolean;
  scale: number;
  workingFrameId?: string;
};

const TARGET_EMAIL_EXPORT_WIDTH = 1200;
const UI_PREFERENCES_KEY = 'inbox-slicer:ui:v12';
const DEFAULT_PANEL_RATIO = 0.38;
let preferenceWrite: Promise<void> = Promise.resolve();

function validPanelRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 0.6;
}

async function loadUiPreferences(): Promise<void> {
  try {
    await preferenceWrite;
    const stored = await figma.clientStorage.getAsync(UI_PREFERENCES_KEY);
    figma.ui.postMessage({
      type: 'UI_PREFERENCES',
      panelRatio: validPanelRatio(stored?.panelRatio) ? stored.panelRatio : DEFAULT_PANEL_RATIO
    });
  } catch {
    figma.ui.postMessage({ type: 'UI_PREFERENCES', panelRatio: DEFAULT_PANEL_RATIO });
    figma.ui.postMessage({ type: 'UI_PREFERENCES_ERROR', message: 'Panel layout could not be restored.' });
  }
}

async function saveUiPreferences(panelRatio: unknown): Promise<void> {
  if (!validPanelRatio(panelRatio)) {
    figma.ui.postMessage({ type: 'UI_PREFERENCES_ERROR', message: 'Invalid panel layout. Adjust the divider and try again.' });
    return;
  }
  const write = preferenceWrite.then(() => figma.clientStorage.setAsync(UI_PREFERENCES_KEY, { panelRatio }));
  // A rejected write must not block later preference changes.
  preferenceWrite = write.catch(() => {});
  try {
    await write;
    figma.ui.postMessage({ type: 'UI_PREFERENCES_SAVED', panelRatio });
  } catch {
    figma.ui.postMessage({ type: 'UI_PREFERENCES_ERROR', message: 'Panel layout could not be saved. Try adjusting the divider again.' });
  }
}

function resizeUi(width: unknown, height: unknown): void {
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) {
    figma.ui.postMessage({ type: 'UI_PREFERENCES_ERROR', message: 'Invalid window size. Try resizing the plugin again.' });
    return;
  }
  const nextWidth = Math.min(1600, Math.max(360, Math.round(width)));
  const nextHeight = Math.min(1200, Math.max(420, Math.round(height)));
  try {
    figma.ui.resize(nextWidth, nextHeight);
    figma.ui.postMessage({ type: 'UI_WINDOW_RESIZED', width: nextWidth, height: nextHeight });
  } catch {
    figma.ui.postMessage({ type: 'UI_PREFERENCES_ERROR', message: 'The plugin window could not be resized. Try again.' });
  }
}

// Working identity is independent of the user's live canvas selection.
let workingFrameId: string | null = null;
let workingFrameLocked = false;
let workingFrameMissing = false;
let frameRequestVersion = 0;
let nextSwitchRequestId = 0;
let pendingFrameSwitch: { requestId: number; frameId: string; fromFrameId: string } | null = null;
let exportInProgress = false;
let watchedWorkingPage: PageNode | null = null;

function isFrameLike(node: SceneNode): node is FrameNode | ComponentNode | InstanceNode {
  return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';
}

function getAutoScale(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.round((TARGET_EMAIL_EXPORT_WIDTH / width) * 10000) / 10000;
}

function collectLayerBounds(root: FrameNode | ComponentNode | InstanceNode): LayerBounds[] {
  const rootX = root.absoluteTransform[0][2];
  const rootY = root.absoluteTransform[1][2];
  const results: LayerBounds[] = [];

  function walk(node: SceneNode): void {
    if (node.id !== root.id && node.visible !== false) {
      const bounds = ('absoluteRenderBounds' in node ? node.absoluteRenderBounds : null) ?? node.absoluteBoundingBox;
      if (bounds && bounds.width > 1 && bounds.height > 1) {
        const x = Math.max(0, bounds.x - rootX);
        const y = Math.max(0, bounds.y - rootY);
        const right = Math.min(root.width, bounds.x - rootX + bounds.width);
        const bottom = Math.min(root.height, bounds.y - rootY + bounds.height);
        if (right > x && bottom > y) {
          results.push({ x, y, width: right - x, height: bottom - y });
        }
      }
    }

    if ('children' in node) {
      for (const child of node.children) walk(child);
    }
  }

  walk(root);
  return results.slice(0, 6000);
}


function collectTextItems(root: FrameNode | ComponentNode | InstanceNode): TextItem[] {
  const rootX = root.absoluteTransform[0][2];
  const rootY = root.absoluteTransform[1][2];
  const results: TextItem[] = [];

  function walk(node: SceneNode): void {
    if (node.type === 'TEXT' && node.visible !== false) {
      const text = node.characters.trim();
      const bounds = node.absoluteRenderBounds ?? node.absoluteBoundingBox;
      if (text && bounds && bounds.width > 0 && bounds.height > 0) {
        const x = Math.max(0, bounds.x - rootX);
        const y = Math.max(0, bounds.y - rootY);
        const right = Math.min(root.width, bounds.x - rootX + bounds.width);
        const bottom = Math.min(root.height, bounds.y - rootY + bounds.height);
        if (right > x && bottom > y) {
          results.push({
            id: node.id,
            text,
            x,
            y,
            width: right - x,
            height: bottom - y
          });
        }
      }
    }

    if ('children' in node) {
      for (const child of node.children) walk(child);
    }
  }

  walk(root);
  return results.slice(0, 4000);
}

function postWorkingFrameState(): void {
  figma.ui.postMessage({
    type: 'WORKING_FRAME_LOCK_STATE',
    frameId: workingFrameId,
    locked: workingFrameLocked,
    missing: workingFrameMissing
  });
}

function cancelFrameSwitch(): void {
  const pending = pendingFrameSwitch;
  pendingFrameSwitch = null;
  frameRequestVersion += 1;
  if (pending) figma.ui.postMessage({ type: 'FRAME_SWITCH_CANCELED', requestId: pending.requestId });
}

function markWorkingFrameMissing(): void {
  if (!workingFrameId || workingFrameMissing) return;
  workingFrameMissing = true;
  figma.ui.postMessage({
    type: 'WORKING_FRAME_MISSING',
    frameId: workingFrameId,
    message: 'The working frame was deleted or is unavailable. Your edits are preserved. Restore it in Figma, or unlock and choose another frame.'
  });
  postWorkingFrameState();
}

function watchWorkingPage(frame: FrameNode | ComponentNode | InstanceNode): void {
  let parent: BaseNode | null = frame.parent;
  while (parent && parent.type !== 'PAGE' && parent.type !== 'DOCUMENT') parent = parent.parent;
  const page = parent?.type === 'PAGE' ? parent : null;
  if (page === watchedWorkingPage) return;
  if (watchedWorkingPage && typeof watchedWorkingPage.off === 'function') {
    watchedWorkingPage.off('nodechange', workingPageChanged);
  }
  watchedWorkingPage = page;
  // Page-level nodechange works with dynamic-page documents without loading all pages.
  if (page && typeof page.on === 'function') page.on('nodechange', workingPageChanged);
}

function workingPageChanged(event: NodeChangeEvent): void {
  if (event.nodeChanges.some(change => change.type === 'DELETE' || change.type === 'CREATE')) {
    void validateWorkingFrame();
  }
}

async function validateWorkingFrame(): Promise<FrameNode | ComponentNode | InstanceNode | null> {
  const id = workingFrameId;
  if (!id) return null;
  try {
    const node = await figma.getNodeByIdAsync(id);
    if (workingFrameId !== id) return null;
    if (!node || node.removed || node.type === 'DOCUMENT' || node.type === 'PAGE' || !isFrameLike(node)) {
      markWorkingFrameMissing();
      return null;
    }
    watchWorkingPage(node);
    if (workingFrameMissing) {
      workingFrameMissing = false;
      postWorkingFrameState();
    }
    return node;
  } catch {
    if (workingFrameId === id) figma.ui.postMessage({ type: 'WORKING_FRAME_SELECTION_NOTICE', message: 'Could not check the working frame. Refresh it and try again; your edits are preserved.' });
    return null;
  }
}

async function loadWorkingFrame(frameId: string, preserveEdits: boolean, switchConfirmed = false): Promise<void> {
  const version = ++frameRequestVersion;
  const oldId = workingFrameId;
  const oldLocked = workingFrameLocked;
  try {
    const frame = await figma.getNodeByIdAsync(frameId);
    if (version !== frameRequestVersion) return;
    if (!frame || frame.removed || frame.type === 'DOCUMENT' || frame.type === 'PAGE' || !isFrameLike(frame)) {
      if (frameId === workingFrameId) markWorkingFrameMissing();
      else figma.ui.postMessage({ type: oldId ? 'WORKING_FRAME_SELECTION_NOTICE' : 'SELECTION_ERROR', message: 'The chosen frame no longer exists. Your current work is preserved.' });
      return;
    }
    const preview = await frame.exportAsync({
      format: 'PNG',
      constraint: { type: 'WIDTH', value: Math.min(900, Math.max(300, frame.width)) }
    });
    if (version !== frameRequestVersion || frame.removed) return;
    const layerBounds = collectLayerBounds(frame);
    const textItems = collectTextItems(frame);
    workingFrameId = frame.id;
    workingFrameLocked = preserveEdits && oldId === frame.id ? oldLocked : true;
    workingFrameMissing = false;
    pendingFrameSwitch = null;
    watchWorkingPage(frame);
    figma.ui.postMessage({
      type: 'FRAME_READY',
      frame: { id: frame.id, name: frame.name, width: frame.width, height: frame.height, autoScale: getAutoScale(frame.width) },
      layerBounds, textItems, preview,
      locked: workingFrameLocked,
      preserveEdits: preserveEdits && oldId === frame.id,
      switchConfirmed
    });
    postWorkingFrameState();
  } catch (error) {
    if (version !== frameRequestVersion) return;
    figma.ui.postMessage({
      type: workingFrameId ? 'WORKING_FRAME_SELECTION_NOTICE' : 'SELECTION_ERROR',
      message: error instanceof Error ? error.message : 'Could not render the selected frame.'
    });
  }
}

async function sendSelection(explicitRefresh = false): Promise<void> {
  if (workingFrameId && workingFrameLocked) {
    if (explicitRefresh) await loadWorkingFrame(workingFrameId, true);
    else await validateWorkingFrame();
    return;
  }
  const selection = figma.currentPage.selection;
  if (selection.length !== 1 || !isFrameLike(selection[0])) {
    cancelFrameSwitch();
    if (!workingFrameId) figma.ui.postMessage({ type: 'SELECTION_ERROR', message: 'Select exactly one email frame, component, or instance.' });
    else figma.ui.postMessage({ type: 'WORKING_FRAME_SELECTION_NOTICE', message: 'Select one frame, component, or instance to switch. Your current working frame and edits are unchanged.' });
    return;
  }
  const frame = selection[0];
  if (!workingFrameId) {
    await loadWorkingFrame(frame.id, false);
    return;
  }
  if (frame.id === workingFrameId) {
    cancelFrameSwitch();
    if (explicitRefresh) await loadWorkingFrame(frame.id, true);
    else await validateWorkingFrame();
    return;
  }
  if (exportInProgress) {
    figma.ui.postMessage({ type: 'WORKING_FRAME_SELECTION_NOTICE', message: 'Wait for image export to finish before switching frames. Your current work is unchanged.' });
    return;
  }
  cancelFrameSwitch();
  pendingFrameSwitch = { requestId: ++nextSwitchRequestId, frameId: frame.id, fromFrameId: workingFrameId };
  figma.ui.postMessage({
    type: 'FRAME_SWITCH_REQUEST', requestId: pendingFrameSwitch.requestId, fromFrameId: workingFrameId,
    frame: { id: frame.id, name: frame.name, width: frame.width, height: frame.height }
  });
}

function setWorkingFrameLock(message: { frameId?: string; locked?: boolean }): void {
  if (!workingFrameId || message.frameId !== workingFrameId || typeof message.locked !== 'boolean') return;
  cancelFrameSwitch();
  workingFrameLocked = message.locked;
  // Unlocking changes only this flag; it never adopts the current canvas selection.
  postWorkingFrameState();
}

async function decideFrameSwitch(message: { requestId?: number; accept?: boolean }): Promise<void> {
  const pending = pendingFrameSwitch;
  if (!pending || message.requestId !== pending.requestId) return;
  if (!message.accept || workingFrameLocked || workingFrameId !== pending.fromFrameId || exportInProgress) {
    cancelFrameSwitch();
    if (exportInProgress) figma.ui.postMessage({ type: 'WORKING_FRAME_SELECTION_NOTICE', message: 'Wait for image export to finish before switching frames.' });
    return;
  }
  await loadWorkingFrame(pending.frameId, false, true);
}

function normaliseCuts(values: number[], max: number): number[] {
  return [...new Set(values.map(value => Math.round(value * 100) / 100))]
    .filter(value => value > 2 && value < max - 2)
    .sort((a, b) => a - b);
}

function buildRegions(
  width: number,
  height: number,
  horizontalCuts: number[],
  verticalCutsBySection: Record<string, number[]>,
  excludeAfterLastCut: boolean
): Region[] {
  const cuts = normaliseCuts(horizontalCuts, height);
  const yStops = excludeAfterLastCut && cuts.length ? [0, ...cuts] : [0, ...cuts, height];
  const regions: Region[] = [];

  for (let sectionIndex = 0; sectionIndex < yStops.length - 1; sectionIndex += 1) {
    const top = yStops[sectionIndex];
    const bottom = yStops[sectionIndex + 1];
    const verticalCuts = normaliseCuts(verticalCutsBySection[String(sectionIndex)] ?? [], width);
    const xStops = [0, ...verticalCuts, width];

    for (let columnIndex = 0; columnIndex < xStops.length - 1; columnIndex += 1) {
      const left = xStops[columnIndex];
      const right = xStops[columnIndex + 1];
      const regionWidth = right - left;
      const regionHeight = bottom - top;
      if (regionWidth <= 0 || regionHeight <= 0) continue;

      const sliceNumber = regions.length + 1;

      regions.push({
        id: `${sectionIndex}-${columnIndex}`,
        sectionIndex,
        columnIndex,
        x: left,
        y: top,
        width: regionWidth,
        height: regionHeight,
        filename: `${sliceNumber}.jpg`
      });
    }
  }

  return regions;
}

async function exportRegions(request: ExportRequest): Promise<void> {
  if (!workingFrameId) {
    figma.ui.postMessage({ type: 'EXPORT_ERROR', message: 'Select an email frame first.' });
    return;
  }

  if (exportInProgress) {
    figma.ui.postMessage({ type: 'EXPORT_ERROR', message: 'An image export is already in progress.' });
    return;
  }
  if (request.workingFrameId && request.workingFrameId !== workingFrameId) {
    figma.ui.postMessage({ type: 'EXPORT_ERROR', message: 'The export does not match the current working frame. Refresh and try again.' });
    return;
  }
  exportInProgress = true;
  const node = await validateWorkingFrame();
  if (!node) {
    exportInProgress = false;
    figma.ui.postMessage({ type: 'EXPORT_ERROR', message: 'The working frame no longer exists or could not be accessed. Your edits are preserved.' });
    return;
  }

  const regions = buildRegions(
    node.width,
    node.height,
    request.horizontalCuts,
    request.verticalCutsBySection,
    request.excludeAfterLastCut
  );
  if (regions.length === 0) {
    exportInProgress = false;
    figma.ui.postMessage({ type: 'EXPORT_ERROR', message: 'No valid slices were generated.' });
    return;
  }

  const temporaryCropFrames: FrameNode[] = [];

  try {
    for (let index = 0; index < regions.length; index += 1) {
      const region = regions[index];
      figma.ui.postMessage({ type: 'EXPORT_PROGRESS', current: index + 1, total: regions.length });

      // Exporting a SliceNode can produce blank files because the slice itself has
      // no rendered children. Instead, clone the selected email into a temporary
      // clipping frame, offset it to the requested region, and export that frame.
      const cropFrame = figma.createFrame();
      cropFrame.name = `Inbox Slicer Crop ${region.filename}`;
      cropFrame.resize(region.width, region.height);
      cropFrame.clipsContent = true;
      cropFrame.fills = [];
      cropFrame.strokes = [];
      cropFrame.effects = [];
      cropFrame.x = -100000;
      cropFrame.y = -100000 - index * (region.height + 20);
      figma.currentPage.appendChild(cropFrame);
      temporaryCropFrames.push(cropFrame);

      const clonedEmail = node.clone();
      cropFrame.appendChild(clonedEmail);
      clonedEmail.x = -region.x;
      clonedEmail.y = -region.y;

      // Use one scale for every region so the complete email frame always
      // maps to a 1200 px export canvas. A full-width slice becomes 1200 px,
      // a half-width slice becomes 600 px, and so on.
      const exportScale = getAutoScale(node.width);
      const bytes = await cropFrame.exportAsync({
        format: 'JPG',
        constraint: { type: 'SCALE', value: exportScale }
      });

      figma.ui.postMessage({
        type: 'EXPORTED_FILE',
        filename: region.filename,
        bytes
      });
    }

    figma.ui.postMessage({
      type: 'EXPORT_COMPLETE',
      count: regions.length,
      zipName: `${node.name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'email'}-slices.zip`
    });
    figma.notify(`Prepared ${regions.length} JPEG slices.`);
  } catch (error) {
    figma.ui.postMessage({
      type: 'EXPORT_ERROR',
      message: error instanceof Error ? error.message : 'Export failed.'
    });
  } finally {
    exportInProgress = false;
    for (const cropFrame of temporaryCropFrames) {
      if (!cropFrame.removed) cropFrame.remove();
    }
  }
}

figma.ui.onmessage = async (message: any | ExportRequest) => {
  if (message.type === 'GET_UI_PREFERENCES') await loadUiPreferences();
  if (message.type === 'SAVE_UI_PREFERENCES') await saveUiPreferences(message.panelRatio);
  if (message.type === 'UI_RESIZE') resizeUi(message.width, message.height);
  if (message.type === 'PREPARE_KLAVIYO_EXPORT') {
    figma.notify('Klaviyo table export data prepared.');
  }
  if (message.type === 'SET_WORKING_FRAME_LOCK') setWorkingFrameLock(message);
  if (message.type === 'FRAME_SWITCH_DECISION') await decideFrameSwitch(message);
  if (message.type === 'REFRESH_SELECTION') await sendSelection(true);
  if (message.type === 'EXPORT') await exportRegions(message as ExportRequest);
  if (message.type === 'CLOSE') figma.closePlugin();
};

figma.on('selectionchange', () => { void sendSelection(); });
void sendSelection();
