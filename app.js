"use strict";

/* =========================================================
  DOM & Global Elements
  ========================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const rootEl = document.documentElement;
const canvasEl = $(".canvas");
const world = $("#world");
const zoomInBtn = $("#zoomIn");
const zoomOutBtn = $("#zoomOut");
const lockBtn = $("#lockToggle");
const zoomLabel = $("#zoomLabel");
const minimap = $("#minimap");
const mmFrame = $("#minimapFrame");
const selectionBoxEl = $("#selectionBox");
const topToolbar = $('.top-toolbar');
const colorPicker = $('#color-picker');
const thicknessSlider = $('#thickness-slider');
const undoBtn = $('#undo-btn');
const redoBtn = $('#redo-btn');
const ariaLiveRegion = $('#aria-live-region');

/* =========================================================
  State Management
  ========================================================= */
const state = {
    panX: 0, panY: 0, zoom: 1, locked: false,
    isDraggingNode: false, isResizingNode: false,
    resizedNode: null, selectedNodes: new Set(),
    activeTool: 'move',
};
let isPanning = false, isBoxSelecting = false;
let pointerStart = { x: 0, y: 0 };
let panStart = { x: 0, y: 0 };
let nodeDragStartPositions = new Map();
let nodeResizeStart = {};
let initialSelectionOnDragStart = new Set();
const editor2dInstances = new Map();
let isApplyingHistory = false;
let lastPointerX = 0;
let lastPointerY = 0;
let updateScheduled = false;

/* =========================================================
  Undo/Redo History Management
  ========================================================= */
const history = {
    stack: [],
    index: -1,

    add(action) {
        if (isApplyingHistory) return;
        if (this.index < this.stack.length - 1) {
            this.stack = this.stack.slice(0, this.index + 1);
        }
        this.stack.push(action);
        this.index++;
        this.updateButtons();
    },

    undo() {
        if (this.index < 0) return;
        isApplyingHistory = true;
        const action = this.stack[this.index];
        
        switch (action.type) {
            case 'create':
                action.after.forEach(({ id }) => $(`[data-node-id="${id}"]`)?.remove());
                break;
            case 'editor:modify':
                this.applyEditorState(action.nodeId, action.before);
                break;
            default:
                this.applyNodeState(action.before);
                break;
        }

        this.index--;
        this.updateButtons();
        setTimeout(() => isApplyingHistory = false, 50);
    },

    redo() {
        if (this.index >= this.stack.length - 1) return;
        isApplyingHistory = true;
        this.index++;
        const action = this.stack[this.index];

        switch (action.type) {
            case 'create':
                 action.after.forEach(nodeState => {
                    const type = nodeState.id.split('-')[0];
                    createNode(type, 0, 0, nodeState);
                });
                break;
            case 'editor:modify':
                this.applyEditorState(action.nodeId, action.after);
                break;
            default:
                this.applyNodeState(action.after);
                break;
        }
        this.updateButtons();
        setTimeout(() => isApplyingHistory = false, 50);
    },

    applyNodeState(nodeStates) {
        nodeStates.forEach(nodeState => {
            const node = $(`[data-node-id="${nodeState.id}"]`);
            if (node) {
                node.style.left = nodeState.left;
                node.style.top = nodeState.top;
                node.style.width = nodeState.width;
                node.style.height = nodeState.height;
                const ed = editor2dInstances.get(nodeState.id);
                if (ed) {
                    const { width, height } = ed.container.getBoundingClientRect();
                    resizeEditorCanvas(ed, width, height);
                    redrawEditor(ed);
                }
            }
        });
    },

    applyEditorState(nodeId, dataUrl) {
        const ed = editor2dInstances.get(nodeId);
        if (ed && dataUrl) {
            const img = new Image();
            img.onload = () => {
                ed.ctx.clearRect(0, 0, ed.canvas.width, ed.canvas.height);
                ed.ctx.drawImage(img, 0, 0, ed.canvas.width, ed.canvas.height);
            };
            img.src = dataUrl;
        }
    },

    updateButtons() {
        undoBtn.disabled = this.index < 0;
        redoBtn.disabled = this.index >= this.stack.length - 1;
    }
};

function captureNodeState(nodes) {
    return Array.from(nodes).map(node => ({
        id: node.dataset.nodeId,
        left: node.style.left,
        top: node.style.top,
        width: node.style.width,
        height: node.style.height,
    }));
}


/* =========================================================
  Constants
  ========================================================= */
const ZOOM = { min: 0.3, max: 2.0, step: 0.1 };
const WORLD = { w: 4000, h: 3000 };
const GRID_SIZE = parseFloat(getComputedStyle(rootEl).getPropertyValue("--grid-size")) || 24;

/* ===================================================================
   Core Canvas & Transform Functions
   =================================================================== */
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function announceToScreenReader(message) {
    ariaLiveRegion.textContent = message;
}

function updateNodeSelection(nodesToSelect) {
    const currentSelection = state.selectedNodes;
    let selectionChanged = false;
    $$('.canvas-node').forEach(node => {
        const isSelected = nodesToSelect.has(node);
        const wasSelected = currentSelection.has(node);
        if (isSelected && !wasSelected) {
            node.setAttribute('aria-selected', 'true');
            node.classList.add('is-selected');
            currentSelection.add(node);
            selectionChanged = true;
        } else if (!isSelected && wasSelected) {
            node.setAttribute('aria-selected', 'false');
            node.classList.remove('is-selected');
            currentSelection.delete(node);
            selectionChanged = true;
        }
    });
    if (selectionChanged) {
        if (currentSelection.size === 0) {
            announceToScreenReader('All nodes deselected.');
        } else if (currentSelection.size === 1) {
            const nodeHeader = $('header span', Array.from(currentSelection)[0]);
            announceToScreenReader(`${nodeHeader.textContent} node selected.`);
        } else {
            announceToScreenReader(`${currentSelection.size} nodes selected.`);
        }
    }
}

function clearSelection() { updateNodeSelection(new Set()); }
function selectSingleNode(nodeEl) { updateNodeSelection(new Set([nodeEl])); }
function toggleNodeSelection(nodeEl) {
    const newSelection = new Set(state.selectedNodes);
    if (newSelection.has(nodeEl)) newSelection.delete(nodeEl);
    else newSelection.add(nodeEl);
    updateNodeSelection(newSelection);
}

function setTransform({ panX = state.panX, panY = state.panY, zoom = state.zoom } = {}) {
    state.panX = panX; state.panY = panY; state.zoom = zoom;
    rootEl.style.setProperty("--pan-x", `${panX}px`);
    rootEl.style.setProperty("--pan-y", `${panY}px`);
    rootEl.style.setProperty("--zoom", zoom);
    const scaledGridSize = GRID_SIZE * zoom;
    canvasEl.style.backgroundSize = `${scaledGridSize * 3}px ${scaledGridSize * 3}px, ${scaledGridSize}px ${scaledGridSize}px`;
    canvasEl.style.backgroundPosition = `${panX}px ${panY}px`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    updateMinimapFrame();
}

function zoomTo(nextZoom, center = null) {
    const prevZoom = state.zoom;
    const zoom = clamp(nextZoom, ZOOM.min, ZOOM.max);
    if (zoom === prevZoom) return;
    const rect = canvasEl.getBoundingClientRect();
    const mouseX = (center?.x ?? rect.left + rect.width / 2) - rect.left;
    const mouseY = (center?.y ?? rect.top + rect.height / 2) - rect.top;
    const worldX = (mouseX - state.panX) / prevZoom;
    const worldY = (mouseY - state.panY) / prevZoom;
    const panX = mouseX - worldX * zoom;
    const panY = mouseY - worldY * zoom;
    world.classList.add("is-zooming");
    setTimeout(() => world.classList.remove("is-zooming"), 220);
    setTransform({ panX, panY, zoom });
}

/* ===================================================================
   Main Pointer & Drag Events for the World Canvas
   =================================================================== */

function onPointerDown(e) {
    if (state.locked || e.button !== 0) return;
    const editorCanvasContainer = e.target.closest('.editor-canvas-container');
    if (editorCanvasContainer) {
        if (state.activeTool === 'text') {
            handleCreativeToolPointerDown(e, null);
            return;
        }
    }
    const targetNode = e.target.closest('.canvas-node');
    const resizeHandle = e.target.closest('.canvas-node__resizer');
    if (resizeHandle) handleNodeResizeStart(e, resizeHandle);
    else if (targetNode) handleNodeDragStart(e, targetNode);
    else if (state.activeTool === 'select' || (state.activeTool === 'move' && e.shiftKey)) handleBoxSelectStart(e);
    else if (state.activeTool === 'move') handlePanStart(e);
}

function onPointerMove(e) {
    if (state.locked) return;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;

    if (!updateScheduled) {
        updateScheduled = true;
        requestAnimationFrame(updatePositions);
    }
}

function updatePositions() {
    if (!updateScheduled) return;

    const dx = lastPointerX - pointerStart.x;
    const dy = lastPointerY - pointerStart.y;

    if (state.isResizingNode) {
        const newWidth = nodeResizeStart.initialWidth + dx / state.zoom;
        const newHeight = nodeResizeStart.initialHeight + dy / state.zoom;
        state.resizedNode.style.width = `${newWidth}px`;
        state.resizedNode.style.height = `${newHeight}px`;
        const ed = editor2dInstances.get(state.resizedNode.dataset.nodeId);
        if (ed) {
            const { width, height } = ed.container.getBoundingClientRect();
            resizeEditorCanvas(ed, width, height);
            redrawEditor(ed);
        }
    } else if (state.isDraggingNode) {
        nodeDragStartPositions.forEach((startPos, node) => {
            node.style.left = `${startPos.x + dx / state.zoom}px`;
            node.style.top = `${startPos.y + dy / state.zoom}px`;
        });
    } else if (isBoxSelecting) {
        handleBoxSelectMove({ clientX: lastPointerX, clientY: lastPointerY });
    } else if (isPanning) {
        setTransform({ panX: panStart.x + dx, panY: panStart.y + dy });
    }

    updateScheduled = false;
}

function onPointerUp(e) {
    updateScheduled = false;
    if (state.isResizingNode) {
        state.resizedNode.classList.remove('is-resizing');
        const afterState = captureNodeState([state.resizedNode]);
        history.add({ type: 'resize', before: [nodeResizeStart.historyState], after: afterState });
        state.isResizingNode = false;
        state.resizedNode = null;
    }
    if (state.isDraggingNode) {
        const beforeState = Array.from(nodeDragStartPositions.entries()).map(([node, pos]) => ({ 
            id: node.dataset.nodeId, left: `${pos.x}px`, top: `${pos.y}px`, 
            width: node.style.width, height: node.style.height 
        }));
        const afterState = captureNodeState(state.selectedNodes);
        history.add({ type: 'move', before: beforeState, after: afterState });
        state.selectedNodes.forEach(node => node.classList.remove('is-dragging'));
        state.isDraggingNode = false;
    }
    if (isBoxSelecting) {
        isBoxSelecting = false;
        selectionBoxEl.style.display = 'none';
        cachedNodesForSelection = [];
    }
    isPanning = false;
    if (canvasEl.hasPointerCapture(e.pointerId)) {
        canvasEl.releasePointerCapture(e.pointerId);
    }
}

function handleCreativeToolPointerDown(e, _unused) {
    if (state.activeTool !== 'text') return;
    const nodeEl = e.target.closest('.canvas-node');
    if (!nodeEl) return;
    const ed = editor2dInstances.get(nodeEl.dataset.nodeId);
    if (!ed) return;
    const rect = ed.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left);
    const y = (e.clientY - rect.top);

    const before = ed.canvas.toDataURL();

    ed.ctx.save();
    ed.ctx.fillStyle = colorPicker.value;
    ed.ctx.font = '24px Arial';
    ed.ctx.textBaseline = 'top';
    ed.ctx.fillText('Your Text Here', x, y);
    ed.ctx.restore();

    const after = ed.canvas.toDataURL();
    history.add({ type: 'editor:modify', nodeId: nodeEl.dataset.nodeId, before, after });
}

function handleNodeResizeStart(e, resizeHandle) {
    e.stopPropagation();
    state.isResizingNode = true;
    state.resizedNode = resizeHandle.parentElement;
    state.resizedNode.classList.add('is-resizing');
    pointerStart = { x: e.clientX, y: e.clientY };

    nodeResizeStart = {
        initialWidth: state.resizedNode.offsetWidth,
        initialHeight: state.resizedNode.offsetHeight,
        historyState: {
            id: state.resizedNode.dataset.nodeId,
            width: state.resizedNode.style.width,
            height: state.resizedNode.style.height,
            left: state.resizedNode.style.left,
            top: state.resizedNode.style.top,
        }
    };
    
    canvasEl.setPointerCapture(e.pointerId);
}

function handleNodeDragStart(e, targetNode) {
    if (e.shiftKey) toggleNodeSelection(targetNode);
    else if (!state.selectedNodes.has(targetNode)) selectSingleNode(targetNode);
    state.isDraggingNode = true;
    pointerStart = { x: e.clientX, y: e.clientY };
    nodeDragStartPositions.clear();
    state.selectedNodes.forEach(node => {
        node.classList.add('is-dragging');
        nodeDragStartPositions.set(node, { x: node.offsetLeft, y: node.offsetTop });
    });
    canvasEl.setPointerCapture(e.pointerId);
}

let cachedNodesForSelection = [];
function handleBoxSelectStart(e) {
    isBoxSelecting = true;
    cachedNodesForSelection = $$('.canvas-node');
    if (!e.shiftKey) clearSelection();
    initialSelectionOnDragStart = new Set(state.selectedNodes);
    pointerStart = { x: e.clientX, y: e.clientY };
    const worldPoint = screenToWorld(e.clientX, e.clientY);
    Object.assign(selectionBoxEl.style, { left: `${worldPoint.x}px`, top: `${worldPoint.y}px`, width: '0px', height: '0px', display: 'block' });
    canvasEl.setPointerCapture(e.pointerId);
}

function handlePanStart(e) {
    isPanning = true;
    pointerStart = { x: e.clientX, y: e.clientY };
    panStart = { x: state.panX, y: state.panY };
    if (!e.shiftKey) clearSelection();
    canvasEl.setPointerCapture(e.pointerId);
}

function handleBoxSelectMove(e) {
    const startPoint = screenToWorld(pointerStart.x, pointerStart.y);
    const currentPoint = screenToWorld(e.clientX, e.clientY);
    const boxLeft = Math.min(startPoint.x, currentPoint.x);
    const boxTop = Math.min(startPoint.y, currentPoint.y);
    const boxWidth = Math.abs(startPoint.x - currentPoint.x);
    const boxHeight = Math.abs(startPoint.y - currentPoint.y);
    Object.assign(selectionBoxEl.style, { left: `${boxLeft}px`, top: `${boxTop}px`, width: `${boxWidth}px`, height: `${boxHeight}px` });
    const nodesToSelect = new Set(initialSelectionOnDragStart);
    cachedNodesForSelection.forEach(node => {
        const nodeLeft = node.offsetLeft, nodeTop = node.offsetTop, nodeWidth = node.offsetWidth, nodeHeight = node.offsetHeight;
        const intersects = (boxLeft < nodeLeft + nodeWidth && boxLeft + boxWidth > nodeLeft && boxTop < nodeTop + nodeHeight && boxTop + boxHeight > nodeTop);
        if (intersects) nodesToSelect.add(node);
        else if (!initialSelectionOnDragStart.has(node)) nodesToSelect.delete(node);
    });
    updateNodeSelection(nodesToSelect);
}

function onWheel(e) {
    if (state.locked) return;
    e.preventDefault();
    const delta = -e.deltaY;
    const factor = delta > 0 ? 1 : -1;
    zoomTo(state.zoom + factor * ZOOM.step, { x: e.clientX, y: e.clientY });
}

/* ===================================================================
   Utility & Node Creation
   =================================================================== */
function screenToWorld(clientX, clientY) {
    const rect = canvasEl.getBoundingClientRect();
    const x = (clientX - rect.left - state.panX) / state.zoom;
    const y = (clientY - rect.top - state.panY) / state.zoom;
    return { x, y };
}

function createNode(type, x, y, restorationState = null) {
    const nodeId = restorationState ? restorationState.id : `${type}-${Date.now()}`;
    if ($(`[data-node-id="${nodeId}"]`)) return;
    const nodeEl = document.createElement('div');
    nodeEl.className = 'canvas-node';
    nodeEl.dataset.nodeId = nodeId;
    nodeEl.tabIndex = 0;
    nodeEl.setAttribute('aria-selected', 'false');
    const nodeTemplates = {
        text: `<header class="canvas-node__header"><span>Text Prompt</span><span class="model-tag">User Input</span></header><div class="canvas-node__content"><textarea class="prompt-textarea" placeholder="Describe what you want to create..."></textarea></div><div class="canvas-node__resizer"></div>`,
        'image-upload': `<header class="canvas-node__header"><span>Image Upload</span><span class="model-tag">Local File</span></header><div class="canvas-node__content canvas-node__content--image-upload"><div class="image-upload-empty-state"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg><span>Upload or drop image</span></div><input type="file" accept="image/*" style="display: none;" /></div><div class="canvas-node__resizer"></div>`,
        'image-editor': `<header class="canvas-node__header"><span>Draw to Edit</span><span class="model-tag">Nano Banana</span></header><div class="canvas-node__content canvas-node__content--editor"><div class="editor-canvas-container"><canvas class="image-editor-canvas"></canvas></div><div class="editor-empty-state"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg><span>Drop image to start</span><input type="file" accept="image/*" style="display: none;" /></div></div><div class="canvas-node__footer canvas-node__footer--editor"><input type="text" class="editor-prompt-input" placeholder="Describe the edit..."><button class="edit-mask-button">Edit</button></div><div class="canvas-node__resizer"></div>`
    };
    if (!nodeTemplates[type]) { console.error("Unknown node type:", type); return; }
    nodeEl.innerHTML = nodeTemplates[type];
    if (restorationState) Object.assign(nodeEl.style, { left: restorationState.left, top: restorationState.top, width: restorationState.width, height: restorationState.height });
    else Object.assign(nodeEl.style, { left: `${x}px`, top: `${y}px`, width: '280px' });
    world.appendChild(nodeEl);
    if (type === 'image-upload') initializeImageUploadNode(nodeEl);
    if (type === 'image-editor') initializeImageEditorNode(nodeEl);
    if (!restorationState) history.add({ type: 'create', before: [], after: captureNodeState([nodeEl]) });
}

function showAddNodeMenu(e) {
    if (e.target.closest('.canvas-node') || state.locked) return;
    e.preventDefault();
    $('.add-node-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'add-node-menu';
    Object.assign(menu.style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
    menu.innerHTML = `<header class="add-node-menu__header">Add Block</header><button data-node-type="text"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" /></svg><span>Text</span><kbd>T</kbd></button><button data-node-type="image-upload"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg><span>Image Upload</span><kbd>U</kbd></button><button data-node-type="image-editor"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z" /></svg><span>Image Editor</span><kbd>E</kbd></button>`;
    document.body.appendChild(menu);
    const { x: worldX, y: worldY } = screenToWorld(e.clientX, e.clientY);
    const closeMenu = () => { menu.remove(); document.removeEventListener('click', closeMenu, { capture: true }); };
    menu.addEventListener('click', (evt) => {
        const button = evt.target.closest('button[data-node-type]');
        if (button) createNode(button.dataset.nodeType, worldX, worldY);
    });
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true, capture: true }), 0);
}

function initializeImageUploadNode(nodeEl) {
    const contentArea = $('.canvas-node__content--image-upload', nodeEl), emptyState = $('.image-upload-empty-state', nodeEl), fileInput = $('input[type="file"]', nodeEl);
    if (!contentArea || !fileInput) return;
    const loadAndDisplayUpload = file => {
        if (!file?.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = e => {
            emptyState.style.display = 'none';
            let img = contentArea.querySelector('img') || document.createElement('img');
            img.src = e.target.result; img.alt = file.name;
            contentArea.appendChild(img);
        };
        reader.readAsDataURL(file);
    };
    contentArea.addEventListener('click', () => fileInput.click());
    contentArea.addEventListener('pointerdown', e => e.stopPropagation());
    fileInput.addEventListener('change', e => e.target.files?.length && loadAndDisplayUpload(e.target.files[0]));
    nodeEl.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); emptyState?.classList.add('drag-over'); });
    nodeEl.addEventListener('dragleave', e => { e.preventDefault(); e.stopPropagation(); emptyState?.classList.remove('drag-over'); });
    nodeEl.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); emptyState?.classList.remove('drag-over'); e.dataTransfer?.files.length && loadAndDisplayUpload(e.dataTransfer.files[0]); });
}

function resizeEditorCanvas(ed, width, height) {
    const prev = document.createElement('canvas');
    prev.width = ed.canvas.width;
    prev.height = ed.canvas.height;
    prev.getContext('2d').drawImage(ed.canvas, 0, 0);

    ed.canvas.width = Math.max(1, Math.floor(width));
    ed.canvas.height = Math.max(1, Math.floor(height));

    ed.ctx.drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, ed.canvas.width, ed.canvas.height);
}

function redrawEditor(ed) {
    if (ed.bgImage) {
        const { canvas, ctx } = ed;
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const cw = canvas.width, ch = canvas.height;
        const ia = ed.bgImage.width / ed.bgImage.height;
        const ca = cw / ch;
        let dw, dh;
        if (ca > ia) { dh = ch; dw = ia * dh; } else { dw = cw; dh = dw / ia; }
        const dx = (cw - dw) / 2, dy = (ch - dh) / 2;
        ctx.drawImage(ed.bgImage, dx, dy, dw, dh);
        ctx.restore();
    }
}

function initializeImageEditorNode(nodeEl) {
    const canvasContainer = nodeEl.querySelector('.editor-canvas-container');
    const canvas = nodeEl.querySelector('.image-editor-canvas');
    const emptyState = nodeEl.querySelector('.editor-empty-state');
    const fileInput = nodeEl.querySelector('input[type="file"]');

    if (!canvas || !canvasContainer || !emptyState || !fileInput) return;

    const ctx = canvas.getContext('2d');
    const ed = {
        nodeId: nodeEl.dataset.nodeId,
        container: canvasContainer,
        canvas,
        ctx,
        drawing: false,
        last: { x: 0, y: 0 },
        bgImage: null,
    };
    editor2dInstances.set(ed.nodeId, ed);

    const contentArea = nodeEl.querySelector('.canvas-node__content');
    contentArea.addEventListener('pointerdown', e => e.stopPropagation());

    const ro = new ResizeObserver(entries => {
        for (const entry of entries) {
            const { width, height } = entry.contentRect;
            resizeEditorCanvas(ed, width, height);
            redrawEditor(ed);
        }
    });
    ro.observe(canvasContainer);

    const getPos = (e) => {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    let beforeSnapshot = null;

    const pointerdown = (e) => {
        if (!['pen','eraser','mask'].includes(state.activeTool)) return;
        e.preventDefault();
        beforeSnapshot = canvas.toDataURL();
        ed.drawing = true;
        const p = getPos(e);
        ed.last = p;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = parseInt(thicknessSlider.value, 10) || 5;
        if (state.activeTool === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = colorPicker.value;
        }
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
    };
    const pointermove = (e) => {
        if (!ed.drawing) return;
        const p = getPos(e);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ed.last = p;
    };
    const pointerup = () => {
        if (!ed.drawing) return;
        ed.drawing = false;
        const after = canvas.toDataURL();
        if (!isApplyingHistory && beforeSnapshot && after !== beforeSnapshot) {
            history.add({ type: 'editor:modify', nodeId: ed.nodeId, before: beforeSnapshot, after });
        }
        beforeSnapshot = null;
        ctx.globalCompositeOperation = 'source-over';
    };

    canvas.addEventListener('pointerdown', pointerdown);
    window.addEventListener('pointermove', pointermove);
    window.addEventListener('pointerup', pointerup);

    const loadAndDisplayImage = file => {
        if (!file?.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = e => {
            emptyState.style.display = 'none';
            const img = new Image();
            img.onload = () => { ed.bgImage = img; redrawEditor(ed); };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    };

    emptyState.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => e.target.files?.length && loadAndDisplayImage(e.target.files[0]));
    nodeEl.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); emptyState?.classList.add('drag-over'); });
    nodeEl.addEventListener('dragleave', e => { e.preventDefault(); e.stopPropagation(); emptyState?.classList.remove('drag-over'); });
    nodeEl.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation(); emptyState?.classList.remove('drag-over');
        if (e.dataTransfer?.files.length) loadAndDisplayImage(e.dataTransfer.files[0]);
    });
}

function updateCreativeTool() {}

function updateAllEditorTools() {}

function initializeDraggableSidebar() {
    const sidebar = $('.modern-sidebar'); if (!sidebar) return;
    let isDragging = false, pointerStartUI = { x: 0, y: 0 }, elementStart = { x: 0, y: 0 };
    const onDragStart = e => {
        if (e.target.closest('button')) return;
        isDragging = true;
        sidebar.classList.add('is-dragging');
        sidebar.setPointerCapture(e.pointerId);
        pointerStartUI = { x: e.clientX, y: e.clientY };
        const rect = sidebar.getBoundingClientRect();
        elementStart = { x: rect.left, y: rect.top };
        Object.assign(sidebar.style, { transform: 'none', left: `${elementStart.x}px`, top: `${elementStart.y}px` });
        document.addEventListener('pointermove', onDragMove);
        document.addEventListener('pointerup', onDragEnd, { once: true });
    };
    const onDragMove = e => {
        if (!isDragging) return;
        Object.assign(sidebar.style, { left: `${elementStart.x + e.clientX - pointerStartUI.x}px`, top: `${elementStart.y + e.clientY - pointerStartUI.y}px` });
    };
    const onDragEnd = e => {
        isDragging = false;
        sidebar.classList.remove('is-dragging');
        if (sidebar.hasPointerCapture(e.pointerId)) sidebar.releasePointerCapture(e.pointerId);
        document.removeEventListener('pointermove', onDragMove);
    };
    sidebar.addEventListener('pointerdown', onDragStart);
}

function initializeSidebarToggles() {
    const sidebarButtons = $$('.modern-sidebar .modern-sidebar__list:first-child .modern-sidebar__button');
    sidebarButtons.forEach(button => {
        button.addEventListener('click', () => {
            sidebarButtons.forEach(btn => btn.classList.remove('is-active'));
            button.classList.add('is-active');
        });
    });
}

function updateMinimapFrame() {
    const rect = canvasEl.getBoundingClientRect();
    const viewLeft = -state.panX / state.zoom, viewTop = -state.panY / state.zoom;
    const viewWidth = rect.width / state.zoom, viewHeight = rect.height / state.zoom;
    const leftPct = (viewLeft / WORLD.w) * 100, topPct = (viewTop / WORLD.h) * 100;
    const rightPct = 100 - ((viewLeft + viewWidth) / WORLD.w) * 100, bottomPct = 100 - ((viewTop + viewHeight) / WORLD.h) * 100;
    mmFrame.style.setProperty("--v-left", `${clamp(leftPct, 0, 100)}%`);
    mmFrame.style.setProperty("--v-right", `${clamp(rightPct, 0, 100)}%`);
    mmFrame.style.setProperty("--v-top", `${clamp(topPct, 0, 100)}%`);
    mmFrame.style.setProperty("--v-bottom", `${clamp(bottomPct, 0, 100)}%`);
}

function onMinimapClick(e) {
    if (state.locked) return;
    const box = minimap.getBoundingClientRect();
    const targetWorldX = (e.clientX - box.left) / box.width * WORLD.w, targetWorldY = (e.clientY - box.top) / box.height * WORLD.h;
    const panX = (canvasEl.clientWidth / 2) - (targetWorldX * state.zoom), panY = (canvasEl.clientHeight / 2) - (targetWorldY * state.zoom);
    setTransform({ panX, panY });
}

function handleKeyboard(e) {
    if (['textarea', 'input'].includes(e.target.tagName.toLowerCase())) return;
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z') { e.preventDefault(); history.undo(); } 
        else if (e.key === 'y') { e.preventDefault(); history.redo(); }
    }
    if (state.selectedNodes.size > 0 && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const beforeState = captureNodeState(state.selectedNodes);
        const delta = e.shiftKey ? 10 : 1;
        state.selectedNodes.forEach(node => {
            let left = node.offsetLeft, top = node.offsetTop;
            if (e.key === 'ArrowUp') top -= delta;
            if (e.key === 'ArrowDown') top += delta;
            if (e.key === 'ArrowLeft') left -= delta;
            if (e.key === 'ArrowRight') left += delta;
            node.style.left = `${left}px`;
            node.style.top = `${top}px`;
        });
        history.add({ type: 'move', before: beforeState, after: captureNodeState(state.selectedNodes) });
    }
}

function bindEvents() {
    canvasEl.addEventListener("wheel", onWheel, { passive: false });
    canvasEl.addEventListener("pointerdown", onPointerDown);
    canvasEl.addEventListener("pointermove", onPointerMove);
    canvasEl.addEventListener("pointerup", onPointerUp);
    canvasEl.addEventListener("contextmenu", showAddNodeMenu);

    zoomInBtn.addEventListener("click", () => zoomTo(state.zoom + ZOOM.step));
    zoomOutBtn.addEventListener("click", () => zoomTo(state.zoom - ZOOM.step));
    
    minimap.parentElement.addEventListener("click", onMinimapClick);
    document.addEventListener("keydown", handleKeyboard);

    topToolbar.addEventListener('click', (e) => {
        const button = e.target.closest('button[data-tool]');
        if (button) {
            const tool = button.dataset.tool;
            
            $$('.top-toolbar__button').forEach(btn => btn.classList.remove('is-active'));
            button.classList.add('is-active');
            
            state.activeTool = tool;
            
            updateAllEditorTools();

            if (['pen', 'eraser'].includes(tool)) {
                canvasEl.classList.add('is-creative-tool-active');
            } else {
                canvasEl.classList.remove('is-creative-tool-active');
            }
        }
    });

    colorPicker.addEventListener('input', () => {
        updateAllEditorTools();
    });

    thicknessSlider.addEventListener('input', () => {
        updateAllEditorTools();
    });

    undoBtn.addEventListener('click', () => history.undo());
    redoBtn.addEventListener('click', () => history.redo());

    initializeDraggableSidebar();
    initializeSidebarToggles();
}

function init() {
    const initialZoom = 0.6;
    const initialPanX = (canvasEl.clientWidth / 2) - (WORLD.w * initialZoom / 2);
    const initialPanY = (canvasEl.clientHeight / 2) - (WORLD.h * initialZoom / 2);
    setTransform({ panX: initialPanX, panY: initialPanY, zoom: initialZoom });
    bindEvents();
    initializeDraggableSidebar();
    initializeSidebarToggles();
    $$('.canvas-node').forEach(nodeEl => {
        if (nodeEl.dataset.nodeId.startsWith('image-editor-')) initializeImageEditorNode(nodeEl);
        else if (nodeEl.dataset.nodeId.startsWith('image-upload-')) initializeImageUploadNode(nodeEl);
    });
    console.log("Canvas ready.");
}

init();