"use strict";
// Reduce the previous 800 px window by 30%; keep the workflow editor width.
figma.showUI(__html__, { width: 560, height: 840, themeColors: true });
const TARGET_EMAIL_EXPORT_WIDTH = 1200;
function resizeUi(width, height) {
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) {
        figma.ui.postMessage({ type: 'UI_WINDOW_ERROR', message: 'Invalid window size. Try resizing the plugin again.' });
        return;
    }
    const nextWidth = Math.min(1600, Math.max(360, Math.round(width)));
    const nextHeight = Math.min(1200, Math.max(420, Math.round(height)));
    try {
        figma.ui.resize(nextWidth, nextHeight);
        figma.ui.postMessage({ type: 'UI_WINDOW_RESIZED', width: nextWidth, height: nextHeight });
    }
    catch {
        figma.ui.postMessage({ type: 'UI_WINDOW_ERROR', message: 'The plugin window could not be resized. Try again.' });
    }
}
// Working identity is independent of the user's live canvas selection.
let workingFrameId = null;
let workingFrameLocked = false;
let workingFrameMissing = false;
let workingFrameRevision = 0;
let frameRequestVersion = 0;
let nextSwitchRequestId = 0;
let pendingFrameSwitch = null;
let exportInProgress = false;
let watchedWorkingPage = null;
function isFrameLike(node) {
    return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';
}
function getAutoScale(width) {
    if (!Number.isFinite(width) || width <= 0)
        return 1;
    return Math.round((TARGET_EMAIL_EXPORT_WIDTH / width) * 10000) / 10000;
}
function collectLayerBounds(root) {
    const rootX = root.absoluteTransform[0][2];
    const rootY = root.absoluteTransform[1][2];
    const results = [];
    function walk(node) {
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
            for (const child of node.children)
                walk(child);
        }
    }
    walk(root);
    return results.slice(0, 6000);
}
function collectTextItems(root) {
    const rootX = root.absoluteTransform[0][2];
    const rootY = root.absoluteTransform[1][2];
    const results = [];
    function walk(node) {
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
            for (const child of node.children)
                walk(child);
        }
    }
    walk(root);
    return results.slice(0, 4000);
}
function postWorkingFrameState() {
    figma.ui.postMessage({
        type: 'WORKING_FRAME_LOCK_STATE',
        frameId: workingFrameId,
        locked: workingFrameLocked,
        missing: workingFrameMissing,
        revision: workingFrameRevision
    });
}
function cancelFrameSwitch() {
    const pending = pendingFrameSwitch;
    pendingFrameSwitch = null;
    frameRequestVersion += 1;
    if (pending)
        figma.ui.postMessage({ type: 'FRAME_SWITCH_CANCELED', requestId: pending.requestId });
}
function markWorkingFrameMissing() {
    if (!workingFrameId || workingFrameMissing)
        return;
    workingFrameMissing = true;
    figma.ui.postMessage({
        type: 'WORKING_FRAME_MISSING',
        frameId: workingFrameId,
        message: 'The working frame was deleted or is unavailable. Your edits are preserved. Restore it in Figma, or unlock and choose another frame.'
    });
    postWorkingFrameState();
}
function watchWorkingPage(frame) {
    let parent = frame.parent;
    while (parent && parent.type !== 'PAGE' && parent.type !== 'DOCUMENT')
        parent = parent.parent;
    const page = parent?.type === 'PAGE' ? parent : null;
    if (page === watchedWorkingPage)
        return;
    if (watchedWorkingPage && typeof watchedWorkingPage.off === 'function') {
        watchedWorkingPage.off('nodechange', workingPageChanged);
    }
    watchedWorkingPage = page;
    // Page-level nodechange works with dynamic-page documents without loading all pages.
    if (page && typeof page.on === 'function')
        page.on('nodechange', workingPageChanged);
}
function workingPageChanged(event) {
    if (event.nodeChanges.some(change => change.type === 'DELETE' || change.type === 'CREATE')) {
        void validateWorkingFrame();
    }
    if (event.nodeChanges.some(change => change.type === 'PROPERTY_CHANGE' && change.id === workingFrameId && change.properties.includes('name'))) {
        void publishWorkingFrameMetadata();
    }
}
async function publishWorkingFrameMetadata() {
    const node = await validateWorkingFrame();
    if (node && node.id === workingFrameId) {
        figma.ui.postMessage({ type: 'WORKING_FRAME_METADATA', frameId: node.id, name: node.name, revision: workingFrameRevision });
    }
}
async function validateWorkingFrame() {
    const id = workingFrameId;
    if (!id)
        return null;
    try {
        const node = await figma.getNodeByIdAsync(id);
        if (workingFrameId !== id)
            return null;
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
    }
    catch {
        if (workingFrameId === id)
            figma.ui.postMessage({ type: 'WORKING_FRAME_SELECTION_NOTICE', message: 'Could not check the working frame. Refresh it and try again; your edits are preserved.' });
        return null;
    }
}
async function loadWorkingFrame(frameId, preserveEdits, switchConfirmed = false, selectionRequestId, requestId) {
    const version = ++frameRequestVersion;
    const oldId = workingFrameId;
    const oldLocked = workingFrameLocked;
    try {
        const frame = await figma.getNodeByIdAsync(frameId);
        if (version !== frameRequestVersion)
            return;
        if (!frame || frame.removed || frame.type === 'DOCUMENT' || frame.type === 'PAGE' || !isFrameLike(frame)) {
            if (frameId === workingFrameId)
                markWorkingFrameMissing();
            figma.ui.postMessage({ type: oldId ? 'WORKING_FRAME_SELECTION_NOTICE' : 'SELECTION_ERROR', selectionRequestId, message: 'The chosen frame no longer exists. Your current work is preserved.' });
            return;
        }
        const preview = await frame.exportAsync({
            format: 'PNG',
            constraint: { type: 'WIDTH', value: Math.min(900, Math.max(300, frame.width)) }
        });
        if (version !== frameRequestVersion)
            return;
        if (frame.removed) {
            if (frameId === workingFrameId)
                markWorkingFrameMissing();
            figma.ui.postMessage({ type: 'WORKING_FRAME_SELECTION_NOTICE', selectionRequestId, message: 'The chosen frame was deleted while loading. Your current work is preserved.' });
            return;
        }
        if (oldId !== workingFrameId)
            return;
        const pending = pendingFrameSwitch;
        if (oldId && oldId !== frame.id && (!switchConfirmed || workingFrameLocked || !pending ||
            pending.requestId !== requestId || pending.selectionRequestId !== selectionRequestId || pending.frameId !== frame.id))
            return;
        const layerBounds = collectLayerBounds(frame);
        const textItems = collectTextItems(frame);
        workingFrameId = frame.id;
        workingFrameLocked = preserveEdits && oldId === frame.id ? oldLocked : true;
        workingFrameMissing = false;
        workingFrameRevision += 1;
        pendingFrameSwitch = null;
        watchWorkingPage(frame);
        figma.ui.postMessage({
            type: 'FRAME_READY',
            frame: { id: frame.id, name: frame.name, width: frame.width, height: frame.height, autoScale: getAutoScale(frame.width) },
            layerBounds, textItems, preview,
            locked: workingFrameLocked,
            preserveEdits: preserveEdits && oldId === frame.id,
            switchConfirmed, requestId, selectionRequestId, fromFrameId: oldId, revision: workingFrameRevision
        });
        postWorkingFrameState();
    }
    catch (error) {
        if (version !== frameRequestVersion)
            return;
        figma.ui.postMessage({
            type: workingFrameId ? 'WORKING_FRAME_SELECTION_NOTICE' : 'SELECTION_ERROR',
            selectionRequestId,
            message: error instanceof Error ? error.message : 'Could not render the selected frame.'
        });
    }
}
// This read occurs once at startup. Later selection events never acquire a frame.
async function initializeWorkingFrame() {
    const selection = figma.currentPage.selection;
    if (selection.length !== 1 || !isFrameLike(selection[0])) {
        figma.ui.postMessage({ type: 'SELECTION_ERROR', message: 'Select an email frame in Figma, then click Use selected frame.' });
        return;
    }
    await loadWorkingFrame(selection[0].id, false);
}
async function handleCanvasSelectionChange() {
    // Browsing the canvas cannot cancel, propose, confirm or load a working frame.
    if (workingFrameId)
        await validateWorkingFrame();
}
async function refreshWorkingFrame() {
    cancelFrameSwitch();
    if (workingFrameId)
        await loadWorkingFrame(workingFrameId, true);
    else
        figma.ui.postMessage({ type: 'SELECTION_ERROR', message: 'Select an email frame in Figma, then click Use selected frame.' });
}
async function useCanvasSelection(message) {
    if (!Number.isSafeInteger(message.selectionRequestId) || message.selectionRequestId <= 0 || message.frameId !== workingFrameId)
        return;
    const selectionRequestId = message.selectionRequestId;
    if (workingFrameId && workingFrameLocked) {
        figma.ui.postMessage({ type: 'WORKING_FRAME_SELECTION_NOTICE', selectionRequestId, message: 'Unlock the working frame before using another canvas selection.' });
        return;
    }
    if (exportInProgress) {
        figma.ui.postMessage({ type: 'WORKING_FRAME_SELECTION_NOTICE', selectionRequestId, message: 'Wait for image export to finish before switching frames. Your current work is unchanged.' });
        return;
    }
    const selection = figma.currentPage.selection;
    if (selection.length !== 1 || !isFrameLike(selection[0])) {
        figma.ui.postMessage({ type: 'WORKING_FRAME_SELECTION_NOTICE', selectionRequestId, message: 'Select one frame, component or instance, then click Use selected frame. Your work is unchanged.' });
        return;
    }
    const frame = selection[0];
    cancelFrameSwitch();
    if (!workingFrameId || frame.id === workingFrameId) {
        await loadWorkingFrame(frame.id, Boolean(workingFrameId), false, selectionRequestId);
        return;
    }
    pendingFrameSwitch = { requestId: ++nextSwitchRequestId, frameId: frame.id, fromFrameId: workingFrameId, selectionRequestId };
    figma.ui.postMessage({
        type: 'FRAME_SWITCH_REQUEST', requestId: pendingFrameSwitch.requestId, fromFrameId: workingFrameId,
        selectionRequestId, frame: { id: frame.id, name: frame.name, width: frame.width, height: frame.height }
    });
}
function setWorkingFrameLock(message) {
    if (!workingFrameId || message.frameId !== workingFrameId || typeof message.locked !== 'boolean')
        return;
    cancelFrameSwitch();
    workingFrameLocked = message.locked;
    // Unlocking changes only this flag; it never adopts the current canvas selection.
    postWorkingFrameState();
}
async function decideFrameSwitch(message) {
    const pending = pendingFrameSwitch;
    if (!pending || message.requestId !== pending.requestId)
        return;
    if (message.accept !== true || workingFrameLocked || workingFrameId !== pending.fromFrameId || exportInProgress) {
        cancelFrameSwitch();
        if (exportInProgress)
            figma.ui.postMessage({ type: 'WORKING_FRAME_SELECTION_NOTICE', message: 'Wait for image export to finish before switching frames.' });
        return;
    }
    await loadWorkingFrame(pending.frameId, false, true, pending.selectionRequestId, pending.requestId);
}
function normaliseCuts(values, max) {
    return [...new Set(values.map(value => Math.round(value * 100) / 100))]
        .filter(value => value > 2 && value < max - 2)
        .sort((a, b) => a - b);
}
function buildRegions(width, height, horizontalCuts, verticalCutsBySection, excludeAfterLastCut) {
    const cuts = normaliseCuts(horizontalCuts, height);
    const yStops = excludeAfterLastCut && cuts.length ? [0, ...cuts] : [0, ...cuts, height];
    const regions = [];
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
            if (regionWidth <= 0 || regionHeight <= 0)
                continue;
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
async function exportRegions(request) {
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
    const regions = buildRegions(node.width, node.height, request.horizontalCuts, request.verticalCutsBySection, request.excludeAfterLastCut);
    if (regions.length === 0) {
        exportInProgress = false;
        figma.ui.postMessage({ type: 'EXPORT_ERROR', message: 'No valid slices were generated.' });
        return;
    }
    const temporaryCropFrames = [];
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
    }
    catch (error) {
        figma.ui.postMessage({
            type: 'EXPORT_ERROR',
            message: error instanceof Error ? error.message : 'Export failed.'
        });
    }
    finally {
        exportInProgress = false;
        for (const cropFrame of temporaryCropFrames) {
            if (!cropFrame.removed)
                cropFrame.remove();
        }
    }
}
figma.ui.onmessage = async (message) => {
    if (message.type === 'UI_RESIZE')
        resizeUi(message.width, message.height);
    if (message.type === 'PREPARE_KLAVIYO_EXPORT') {
        figma.notify('Klaviyo table export data prepared.');
    }
    if (message.type === 'SET_WORKING_FRAME_LOCK')
        setWorkingFrameLock(message);
    if (message.type === 'FRAME_SWITCH_DECISION')
        await decideFrameSwitch(message);
    if (message.type === 'USE_CANVAS_SELECTION')
        await useCanvasSelection(message);
    if (message.type === 'REFRESH_SELECTION')
        await refreshWorkingFrame();
    if (message.type === 'EXPORT')
        await exportRegions(message);
    if (message.type === 'CLOSE')
        figma.closePlugin();
};
figma.on('selectionchange', () => { void handleCanvasSelectionChange(); });
void initializeWorkingFrame();
