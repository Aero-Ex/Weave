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
const minimapCanvas = $("#minimap");
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
    selectedNodes: new Set(),
    activeTool: 'move',
    activeEditorNode: null,
    
    // Encapsulated state for pointer actions to avoid global scope pollution
    isPanning: false,
    isBoxSelecting: false,
    isDraggingNode: false,
    isResizingNode: false,
    resizedNode: null,

    // Store transient data related to an ongoing pointer action
    pointerAction: {
        pointerStart: { x: 0, y: 0 },
        panStart: { x: 0, y: 0 },
        nodeDragStartPositions: new Map(),
        nodeResizeStart: {},
        initialSelectionOnDragStart: new Set(),
        lastPointerX: 0,
        lastPointerY: 0,
        updateScheduled: false,
    }
};
const editor2dInstances = new Map();
let isApplyingHistory = false;

/* =========================================================
  Constants
  ========================================================= */
const ZOOM = { min: 0.3, max: 2.0, step: 0.1, TRANSITION_DURATION: 220 };
const WORLD = { w: 4000, h: 3000 };
const GRID_SIZE = parseFloat(getComputedStyle(rootEl).getPropertyValue("--grid-size")) || 24;
const EDITOR = { CROP_HANDLE_HITBOX: 8 };

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
                renderMinimap(); // Update minimap on node removal
                break;
            case 'editor:modify':
                this.applyEditorState(action.nodeId, action.before, action.beforeMetadata);
                break;
            default:
                this.applyNodeState(action.before);
                break;
        }

        this.index--;
        this.updateButtons();
        isApplyingHistory = false; // FIX: Removed fragile setTimeout
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
                    createNode(type, 0, 0, nodeState); // Position will be overridden by applyNodeState
                });
                break;
            case 'editor:modify':
                this.applyEditorState(action.nodeId, action.after, action.metadata);
                break;
            default:
                this.applyNodeState(action.after);
                break;
        }
        this.updateButtons();
        isApplyingHistory = false; // FIX: Removed fragile setTimeout
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
        renderMinimap(); // Update minimap after state is applied
    },

    applyEditorState(nodeId, dataUrl, metadata) {
        const ed = editor2dInstances.get(nodeId);
        if (!ed || !dataUrl) return;
    
        const img = new Image();
        img.onload = () => {
            ed.bgImage = img;
            if (metadata && metadata.pos) {
                ed.bgImagePos = { ...metadata.pos };
                ed.bgImageScale = metadata.scale;
            } else {
                ed.bgImagePos = { x: 0, y: 0 };
                ed.bgImageScale = 1;
            }
            redrawEditor(ed);
        };
        img.src = dataUrl;
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
    setTimeout(() => world.classList.remove("is-zooming"), ZOOM.TRANSITION_DURATION);
    setTransform({ panX, panY, zoom });
}

/* ===================================================================
   Main Pointer & Drag Events for the World Canvas
   =================================================================== */

function onPointerDown(e) {
    if (state.locked || e.button !== 0) return;
    
    const targetNode = e.target.closest('.canvas-node');
    const resizeHandle = e.target.closest('.canvas-node__resizer');

    if (resizeHandle) {
        handleNodeResizeStart(e, resizeHandle);
    } else if (targetNode) {
        handleNodeDragStart(e, targetNode);
    } else if (state.activeTool === 'select') {
        handleBoxSelectStart(e);
    } else {
        handlePanStart(e);
    }
}

function onPointerMove(e) {
    if (state.locked) return;
    state.pointerAction.lastPointerX = e.clientX;
    state.pointerAction.lastPointerY = e.clientY;

    if (!state.pointerAction.updateScheduled) {
        state.pointerAction.updateScheduled = true;
        requestAnimationFrame(updatePositions);
    }
}

function updatePositions() {
    if (!state.pointerAction.updateScheduled) return;

    const { pointerStart, lastPointerX, lastPointerY, nodeResizeStart, nodeDragStartPositions, panStart } = state.pointerAction;
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
    } else if (state.isBoxSelecting) {
        handleBoxSelectMove({ clientX: lastPointerX, clientY: lastPointerY });
    } else if (state.isPanning) {
        setTransform({ panX: panStart.x + dx, panY: panStart.y + dy });
    }

    state.pointerAction.updateScheduled = false;
}

function onPointerUp(e) {
    state.pointerAction.updateScheduled = false;
    if (state.isResizingNode) {
        state.resizedNode.classList.remove('is-resizing');
        const afterState = captureNodeState([state.resizedNode]);
        history.add({ type: 'resize', before: [state.pointerAction.nodeResizeStart.historyState], after: afterState });
        state.isResizingNode = false;
        state.resizedNode = null;
        renderMinimap();
    }
    if (state.isDraggingNode) {
        const beforeState = Array.from(state.pointerAction.nodeDragStartPositions.entries()).map(([node, pos]) => ({ 
            id: node.dataset.nodeId, left: `${pos.x}px`, top: `${pos.y}px`, 
            width: node.style.width, height: node.style.height 
        }));
        const afterState = captureNodeState(state.selectedNodes);
        history.add({ type: 'move', before: beforeState, after: afterState });
        state.selectedNodes.forEach(node => node.classList.remove('is-dragging'));
        state.isDraggingNode = false;
        renderMinimap();
    }
    if (state.isBoxSelecting) {
        state.isBoxSelecting = false;
        selectionBoxEl.style.display = 'none';
        cachedNodesForSelection = [];
    }
    state.isPanning = false;
    if (canvasEl.hasPointerCapture(e.pointerId)) {
        canvasEl.releasePointerCapture(e.pointerId);
    }
}

function handleNodeResizeStart(e, resizeHandle) {
    e.stopPropagation();
    state.isResizingNode = true;
    state.resizedNode = resizeHandle.parentElement;
    state.resizedNode.classList.add('is-resizing');
    state.pointerAction.pointerStart = { x: e.clientX, y: e.clientY };

    state.pointerAction.nodeResizeStart = {
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
    if (e.target.closest('.canvas-node__content')) return;

    if (e.shiftKey) toggleNodeSelection(targetNode);
    else if (!state.selectedNodes.has(targetNode)) selectSingleNode(targetNode);
    
    state.isDraggingNode = true;
    state.pointerAction.pointerStart = { x: e.clientX, y: e.clientY };
    state.pointerAction.nodeDragStartPositions.clear();
    state.selectedNodes.forEach(node => {
        node.classList.add('is-dragging');
        state.pointerAction.nodeDragStartPositions.set(node, { x: node.offsetLeft, y: node.offsetTop });
    });
    canvasEl.setPointerCapture(e.pointerId);
}

let cachedNodesForSelection = [];
function handleBoxSelectStart(e) {
    state.isBoxSelecting = true;
    cachedNodesForSelection = $$('.canvas-node');
    if (!e.shiftKey) clearSelection();
    state.pointerAction.initialSelectionOnDragStart = new Set(state.selectedNodes);
    state.pointerAction.pointerStart = { x: e.clientX, y: e.clientY };
    const worldPoint = screenToWorld(e.clientX, e.clientY);
    Object.assign(selectionBoxEl.style, { left: `${worldPoint.x}px`, top: `${worldPoint.y}px`, width: '0px', height: '0px', display: 'block' });
    canvasEl.setPointerCapture(e.pointerId);
}

function handlePanStart(e) {
    state.isPanning = true;
    state.pointerAction.pointerStart = { x: e.clientX, y: e.clientY };
    state.pointerAction.panStart = { x: state.panX, y: state.panY };
    if (!e.shiftKey) clearSelection();
    canvasEl.setPointerCapture(e.pointerId);
}

function handleBoxSelectMove(e) {
    const startPoint = screenToWorld(state.pointerAction.pointerStart.x, state.pointerAction.pointerStart.y);
    const currentPoint = screenToWorld(e.clientX, e.clientY);
    const boxLeft = Math.min(startPoint.x, currentPoint.x);
    const boxTop = Math.min(startPoint.y, currentPoint.y);
    const boxWidth = Math.abs(startPoint.x - currentPoint.x);
    const boxHeight = Math.abs(startPoint.y - currentPoint.y);
    Object.assign(selectionBoxEl.style, { left: `${boxLeft}px`, top: `${boxTop}px`, width: `${boxWidth}px`, height: `${boxHeight}px` });
    
    const nodesToSelect = new Set(state.pointerAction.initialSelectionOnDragStart);
    cachedNodesForSelection.forEach(node => {
        const nodeLeft = node.offsetLeft, nodeTop = node.offsetTop, nodeWidth = node.offsetWidth, nodeHeight = node.offsetHeight;
        const intersects = (boxLeft < nodeLeft + nodeWidth && boxLeft + boxWidth > nodeLeft && boxTop < nodeTop + nodeHeight && boxTop + boxHeight > nodeTop);
        if (intersects) {
            nodesToSelect.add(node);
        } else if (!state.pointerAction.initialSelectionOnDragStart.has(node)) {
            nodesToSelect.delete(node);
        }
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

function getRelativePointerPos(event, element) {
    const rect = element.getBoundingClientRect();
    return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
    };
}

// FIX: Refactored to use HTML <template> elements for maintainability
function createNode(type, x, y, restorationState = null) {
    const nodeId = restorationState ? restorationState.id : `${type}-${Date.now()}`;
    if ($(`[data-node-id="${nodeId}"]`)) return;

    const template = $(`#node-template-${type}`);
    if (!template) {
        console.error("Unknown node type:", type);
        return;
    }

    const nodeEl = document.createElement('div');
    nodeEl.className = 'canvas-node';
    nodeEl.dataset.nodeId = nodeId;
    nodeEl.tabIndex = 0;
    nodeEl.setAttribute('aria-selected', 'false');
    nodeEl.innerHTML = template.innerHTML;

    if (restorationState) {
        Object.assign(nodeEl.style, { left: restorationState.left, top: restorationState.top, width: restorationState.width, height: restorationState.height });
    } else {
        Object.assign(nodeEl.style, { left: `${x}px`, top: `${y}px`, width: '280px' });
    }
    
    world.appendChild(nodeEl);
    
    if (type === 'image-upload') initializeImageUploadNode(nodeEl);
    if (type === 'image-editor') initializeImageEditorNode(nodeEl);

    if (!restorationState) {
        history.add({ type: 'create', before: [], after: captureNodeState([nodeEl]) });
    }
    renderMinimap(); // Update minimap after creating a node
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
    if (!ed.canvas) return;
    const { canvas, ctx } = ed;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (ed.bgImage) {
        ctx.save();
        const { x, y, w, h } = getDrawnImageRect(ed);
        ctx.drawImage(ed.bgImage, x, y, w, h);
        ctx.restore();
    }

    if (ed.isCroppingActive || ed.isDefiningCropArea) {
        const { x, y, w, h } = ed.cropBox;
        const normBox = {
            x: w < 0 ? x + w : x,
            y: h < 0 ? y + h : y,
            w: Math.abs(w),
            h: Math.abs(h),
        };
        ctx.save();
        ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
        ctx.beginPath();
        ctx.rect(0, 0, canvas.width, canvas.height);
        ctx.rect(normBox.x + normBox.w, normBox.y, -normBox.w, normBox.h);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 1;
        ctx.strokeRect(normBox.x, normBox.y, normBox.w, normBox.h);
        
        if (ed.isCroppingActive) {
            ctx.fillStyle = "white";
            ed.handles.forEach(handle => ctx.fillRect(handle.x - 4, handle.y - 4, 8, 8));
        }
        ctx.restore();
    }
}

function getDrawnImageRect(ed) {
    const { canvas, bgImage, bgImagePos, bgImageScale } = ed;
    if (!bgImage) return { x: 0, y: 0, w: 0, h: 0 };
    
    const cw = canvas.width;
    const ch = canvas.height;
    const imgAspectRatio = bgImage.width / bgImage.height;
    const canvasAspectRatio = cw / ch;
    let baseW, baseH;

    if (canvasAspectRatio > imgAspectRatio) {
        baseH = ch; baseW = baseH * imgAspectRatio;
    } else {
        baseW = cw; baseH = baseW / imgAspectRatio;
    }

    const w = baseW * bgImageScale;
    const h = baseH * bgImageScale;
    const x = (cw - w) / 2 + bgImagePos.x;
    const y = (ch - h) / 2 + bgImagePos.y;
    return { x, y, w, h };
}


function initializeImageEditorNode(nodeEl) {
    const canvasContainer = nodeEl.querySelector('.editor-canvas-container');
    const canvas = nodeEl.querySelector('.image-editor-canvas');
    const emptyState = nodeEl.querySelector('.editor-empty-state');
    const fileInput = nodeEl.querySelector('input[type="file"]');
    const cropConfirmBtn = nodeEl.querySelector('.crop-confirm-button');

    if (!canvas || !canvasContainer || !emptyState || !fileInput) return;

    const ctx = canvas.getContext('2d');
    const ed = {
        nodeId: nodeEl.dataset.nodeId, container: canvasContainer, canvas, ctx,
        nodeEl,
        drawing: false, isMovingImage: false, isTransforming: false,
        bgImage: null, bgImagePos: { x: 0, y: 0 }, bgImageScale: 1,
        moveStart: { pointer: {x: 0, y: 0}, image: {x: 0, y: 0} },
        opStart: { x: 0, y: 0 },
        transformStart: { scale: 1, y: 0 },
        
        isDefiningCropArea: false, isCroppingActive: false,
        cropBox: { x: 0, y: 0, w: 0, h: 0 },
        cropStartBox: null,
        handles: [], activeHandle: null, isMovingCropBox: false,
    };
    editor2dInstances.set(ed.nodeId, ed);
    
    const ro = new ResizeObserver(entries => {
        for (const entry of entries) {
            const { width, height } = entry.contentRect;
            resizeEditorCanvas(ed, width, height);
            redrawEditor(ed);
        }
    });
    ro.observe(canvasContainer);

    let beforeSnapshot = null;

    const onEditorPointerMove = (e) => {
        if (ed.isDefiningCropArea || ed.isCroppingActive) {
            handleCropPointerMove(e, ed);
        } else {
            const p = getRelativePointerPos(e, canvas);
            switch(state.activeTool) {
                case 'move':
                    if (ed.isMovingImage) {
                        const dx = p.x - ed.moveStart.pointer.x;
                        const dy = p.y - ed.moveStart.pointer.y;
                        ed.bgImagePos.x = ed.moveStart.image.x + dx;
                        ed.bgImagePos.y = ed.moveStart.image.y + dy;
                        redrawEditor(ed);
                    }
                    break;
                case 'pen': case 'eraser':
                    if (ed.drawing) { ctx.lineTo(p.x, p.y); ctx.stroke(); }
                    break;
                case 'transform':
                     if(ed.isTransforming) {
                        const dy = ed.transformStart.y - p.y;
                        const scaleFactor = 1 + (dy / 200);
                        ed.bgImageScale = Math.max(0.1, ed.transformStart.scale * scaleFactor);
                        redrawEditor(ed);
                     }
                    break;
            }
        }
    };

    const onEditorPointerUp = (e) => {
        if (ed.isDefiningCropArea) {
            ed.isDefiningCropArea = false;
            if (ed.cropBox.w < 0) { ed.cropBox.x += ed.cropBox.w; ed.cropBox.w = Math.abs(ed.cropBox.w); }
            if (ed.cropBox.h < 0) { ed.cropBox.y += ed.cropBox.h; ed.cropBox.h = Math.abs(ed.cropBox.h); }

            if(ed.cropBox.w > 5 && ed.cropBox.h > 5) {
                ed.isCroppingActive = true;
                updateCropHandles(ed);
            } else {
                ed.isCroppingActive = false;
            }
            redrawEditor(ed);
        }

        ed.isMovingImage = false;
        ed.isTransforming = false;
        ed.activeHandle = null;
        ed.isMovingCropBox = false;

        if (ed.drawing) {
            ed.drawing = false;
            const after = canvas.toDataURL();
            const metadata = { pos: { ...ed.bgImagePos }, scale: ed.bgImageScale };
            const beforeMeta = { pos: { ...ed.bgImagePos }, scale: ed.bgImageScale };
            if (!isApplyingHistory && beforeSnapshot && after !== beforeSnapshot) {
                history.add({ type: 'editor:modify', nodeId: ed.nodeId, before: beforeSnapshot, after, metadata, beforeMetadata: beforeMeta });
            }
            beforeSnapshot = null;
            ctx.globalCompositeOperation = 'source-over';
        }
        
        window.removeEventListener('pointermove', onEditorPointerMove);
        window.removeEventListener('pointerup', onEditorPointerUp);
    };

    const onEditorPointerDown = (e) => {
        e.stopPropagation(); 
        state.activeEditorNode = ed;
        
        if (state.activeTool === 'crop') {
            handleCropPointerDown(e, ed);
        } else {
            if (ed.isCroppingActive) endCrop(ed, false);
            
            const p = getRelativePointerPos(e, canvas);
            ed.opStart = p;
            
            switch (state.activeTool) {
                case 'move':
                    if (ed.bgImage) {
                        ed.isMovingImage = true;
                        ed.moveStart.pointer = p;
                        ed.moveStart.image = { ...ed.bgImagePos };
                    }
                    break;
                case 'pen': case 'eraser': case 'mask':
                    beforeSnapshot = canvas.toDataURL();
                    ed.drawing = true;
                    Object.assign(ctx, { lineCap: 'round', lineJoin: 'round', lineWidth: parseInt(thicknessSlider.value, 10) || 5 });
                    ctx.globalCompositeOperation = (state.activeTool === 'eraser') ? 'destination-out' : 'source-over';
                    ctx.strokeStyle = (state.activeTool === 'eraser') ? 'rgba(0,0,0,1)' : colorPicker.value;
                    ctx.beginPath();
                    ctx.moveTo(p.x, p.y);
                    break;
                case 'text':
                    beforeSnapshot = canvas.toDataURL();
                    const metadata = { pos: { ...ed.bgImagePos }, scale: ed.bgImageScale };
                    Object.assign(ctx, { fillStyle: colorPicker.value, font: '24px Arial', textBaseline: 'top' });
                    ctx.fillText('Your Text Here', p.x, p.y);
                    const after = canvas.toDataURL();
                    history.add({ type: 'editor:modify', nodeId: ed.nodeId, before: beforeSnapshot, after, metadata });
                    break;
                case 'transform':
                    if (ed.bgImage) {
                        ed.isTransforming = true;
                        ed.transformStart.scale = ed.bgImageScale;
                        ed.transformStart.y = p.y;
                    }
                    break;
            }
        }
        
        window.addEventListener('pointermove', onEditorPointerMove);
        window.addEventListener('pointerup', onEditorPointerUp, { once: true });
    };

    const contentArea = nodeEl.querySelector('.canvas-node__content--editor');
    contentArea.addEventListener('pointerdown', onEditorPointerDown);
    cropConfirmBtn.addEventListener('click', () => endCrop(ed, true));

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

function updateCropHandles(ed) {
    const { x, y, w, h } = ed.cropBox;
    ed.handles = [
        { x: x, y: y, cursor: 'nwse-resize', name: 'tl' },
        { x: x + w / 2, y: y, cursor: 'ns-resize', name: 'tm' },
        { x: x + w, y: y, cursor: 'nesw-resize', name: 'tr' },
        { x: x + w, y: y + h / 2, cursor: 'ew-resize', name: 'mr' },
        { x: x + w, y: y + h, cursor: 'nwse-resize', name: 'br' },
        { x: x + w / 2, y: y + h, cursor: 'ns-resize', name: 'bm' },
        { x: x, y: y + h, cursor: 'nesw-resize', name: 'bl' },
        { x: x, y: y + h / 2, cursor: 'ew-resize', name: 'ml' },
    ];
}

function endCrop(ed, apply) {
    if (!ed.isCroppingActive && !ed.isDefiningCropArea) return;

    if (apply) {
        const { x, y, w, h } = ed.cropBox;
        if (w > 1 && h > 1 && ed.bgImage) {
            const before = ed.bgImage.src;
            const beforeMeta = { pos: { ...ed.bgImagePos }, scale: ed.bgImageScale };

            const imgRect = getDrawnImageRect(ed);
            if (imgRect.w <= 0 || imgRect.h <= 0) {
                console.error('Invalid image dimensions for cropping');
            } else {
                const sourceX = ((x - imgRect.x) / imgRect.w) * ed.bgImage.width;
                const sourceY = ((y - imgRect.y) / imgRect.h) * ed.bgImage.height;
                const sourceW = (w / imgRect.w) * ed.bgImage.width;
                const sourceH = (h / imgRect.h) * ed.bgImage.height;

                const finalCanvas = document.createElement('canvas');
                finalCanvas.width = Math.max(1, sourceW);
                finalCanvas.height = Math.max(1, sourceH);
                finalCanvas.getContext('2d').drawImage(ed.bgImage, sourceX, sourceY, sourceW, sourceH, 0, 0, finalCanvas.width, finalCanvas.height);
                
                const newImage = new Image();
                newImage.onload = () => {
                    ed.bgImage = newImage;
                    ed.bgImagePos = { x: 0, y: 0 };
                    ed.bgImageScale = 1;
                    redrawEditor(ed);
                    
                    const after = newImage.src;
                    const afterMeta = { pos: { ...ed.bgImagePos }, scale: ed.bgImageScale };
                    history.add({ type: 'editor:modify', nodeId: ed.nodeId, before, after, metadata: afterMeta, beforeMetadata: beforeMeta });
                };
                newImage.src = finalCanvas.toDataURL();
            }
        }
    }
    
    ed.isCroppingActive = false;
    ed.isDefiningCropArea = false;
    ed.activeHandle = null;
    ed.isMovingCropBox = false;
    ed.canvas.style.cursor = 'crosshair';
    redrawEditor(ed);
}

function handleCropPointerDown(e, ed) {
    const pos = getRelativePointerPos(e, ed.canvas);
    
    if (ed.isCroppingActive) {
        ed.activeHandle = ed.handles.find(h => Math.abs(pos.x - h.x) < EDITOR.CROP_HANDLE_HITBOX && Math.abs(pos.y - h.y) < EDITOR.CROP_HANDLE_HITBOX) || null;
        
        if (ed.activeHandle) {
            ed.isMovingCropBox = false;
            ed.cropStartBox = { ...ed.cropBox };
        } else if (pos.x > ed.cropBox.x && pos.x < ed.cropBox.x + ed.cropBox.w && pos.y > ed.cropBox.y && pos.y < ed.cropBox.y + ed.cropBox.h) {
            ed.isMovingCropBox = true;
            ed.cropStartBox = { ...ed.cropBox };
        } else {
             endCrop(ed, false);
             return;
        }
    } else { 
        if (!ed.bgImage) return;
        ed.isDefiningCropArea = true;
        ed.cropBox = { x: pos.x, y: pos.y, w: 0, h: 0 };
    }
    ed.opStart = pos;
}

function handleCropPointerMove(e, ed) {
    const pos = getRelativePointerPos(e, ed.canvas);
    const dx = pos.x - ed.opStart.x;
    const dy = pos.y - ed.opStart.y;

    if (ed.isDefiningCropArea) {
        ed.cropBox.w = dx;
        ed.cropBox.h = dy;
    } else if (ed.activeHandle) {
        const { name } = ed.activeHandle;
        const start = ed.cropStartBox;
        
        if (name.includes('l')) { ed.cropBox.x = start.x + dx; ed.cropBox.w = start.w - dx; }
        if (name.includes('r')) { ed.cropBox.w = start.w + dx; }
        if (name.includes('t')) { ed.cropBox.y = start.y + dy; ed.cropBox.h = start.h - dy; }
        if (name.includes('b')) { ed.cropBox.h = start.h + dy; }

        if (e.shiftKey && (name === 'tl' || name === 'tr' || name === 'bl' || name === 'br')) {
            if (Math.abs(start.w) > 0 && Math.abs(start.h) > 0) {
                const aspect = Math.abs(start.w / start.h);
                const wChange = Math.abs(ed.cropBox.w) - Math.abs(start.w);
                const hChange = Math.abs(ed.cropBox.h) - Math.abs(start.h);
                if (Math.abs(wChange) > Math.abs(hChange)) {
                    ed.cropBox.h = Math.sign(ed.cropBox.h) * Math.abs(ed.cropBox.w) / aspect;
                } else {
                    ed.cropBox.w = Math.sign(ed.cropBox.w) * Math.abs(ed.cropBox.h) * aspect;
                }
                if (name.includes('l')) ed.cropBox.x = start.x + start.w - ed.cropBox.w;
                if (name.includes('t')) ed.cropBox.y = start.y + start.h - ed.cropBox.h;
            }
        }
        updateCropHandles(ed);
    } else if (ed.isMovingCropBox) {
        const start = ed.cropStartBox;
        ed.cropBox.x = start.x + dx;
        ed.cropBox.y = start.y + dy;
        updateCropHandles(ed);
    } else {
        const handle = ed.handles.find(h => Math.abs(pos.x - h.x) < EDITOR.CROP_HANDLE_HITBOX && Math.abs(pos.y - h.y) < EDITOR.CROP_HANDLE_HITBOX);
        if (handle) {
            ed.canvas.style.cursor = handle.cursor;
        } else if (pos.x > ed.cropBox.x && pos.x < ed.cropBox.x + ed.cropBox.w && pos.y > ed.cropBox.y && pos.y < ed.cropBox.y + ed.cropBox.h) {
            ed.canvas.style.cursor = 'move';
        } else {
            ed.canvas.style.cursor = 'crosshair';
        }
    }
    redrawEditor(ed);
}

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

// FIX: New function to render the minimap content
function renderMinimap() {
    if (!minimapCanvas) return;
    const ctx = minimapCanvas.getContext('2d');
    const nodes = $$('.canvas-node');
    const scaleX = minimapCanvas.width / WORLD.w;
    const scaleY = minimapCanvas.height / WORLD.h;
    
    ctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
    ctx.fillStyle = 'rgba(150, 163, 179, 0.4)';

    nodes.forEach(node => {
        const x = node.offsetLeft * scaleX;
        const y = node.offsetTop * scaleY;
        const w = node.offsetWidth * scaleX;
        const h = node.offsetHeight * scaleY;
        ctx.fillRect(x, y, w, h);
    });
}

function onMinimapClick(e) {
    if (state.locked) return;
    const box = minimap.parentElement.getBoundingClientRect();
    const targetWorldX = (e.clientX - box.left) / box.width * WORLD.w;
    const targetWorldY = (e.clientY - box.top) / box.height * WORLD.h;
    const panX = (canvasEl.clientWidth / 2) - (targetWorldX * state.zoom);
    const panY = (canvasEl.clientHeight / 2) - (targetWorldY * state.zoom);
    setTransform({ panX, panY });
}

function handleKeyboard(e) {
    if (['textarea', 'input'].includes(e.target.tagName.toLowerCase())) return;

    if (state.activeEditorNode && (state.activeEditorNode.isCroppingActive || state.activeEditorNode.isDefiningCropArea)) {
        if (e.key === 'Enter') { e.preventDefault(); endCrop(state.activeEditorNode, true); } 
        else if (e.key === 'Escape') { e.preventDefault(); endCrop(state.activeEditorNode, false); }
        return;
    }

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
        renderMinimap();
    }
}

function bindEvents() {
    canvasEl.addEventListener("wheel", onWheel, { passive: false });
    canvasEl.addEventListener("pointerdown", onPointerDown);
    canvasEl.addEventListener("contextmenu", showAddNodeMenu);

    zoomInBtn.addEventListener("click", () => zoomTo(state.zoom + ZOOM.step));
    zoomOutBtn.addEventListener("click", () => zoomTo(state.zoom - ZOOM.step));
    
    minimap.parentElement.addEventListener("click", onMinimapClick);
    document.addEventListener("keydown", handleKeyboard);

    topToolbar.addEventListener('click', (e) => {
        const button = e.target.closest('button[data-tool]');
        if (button) {
            const tool = button.dataset.tool;
            if (state.activeTool === 'crop' && tool !== 'crop' && state.activeEditorNode) {
                 endCrop(state.activeEditorNode, false);
            }
            $$('.top-toolbar__button').forEach(btn => btn.classList.remove('is-active'));
            button.classList.add('is-active');
            state.activeTool = tool;
            
            canvasEl.className = 'canvas'; // Reset classes
            if (['pen', 'eraser', 'text', 'mask'].includes(tool)) {
                canvasEl.classList.add('is-creative-tool-active');
            } else if (['move', 'select', 'crop', 'transform'].includes(tool)) {
                canvasEl.classList.add(`is-${tool}-tool-active`);
            }
        }
    });

    undoBtn.addEventListener('click', () => history.undo());
    redoBtn.addEventListener('click', () => history.redo());

    // FIX: Moved initialization calls here to avoid redundancy
    initializeDraggableSidebar();
    initializeSidebarToggles();
}

function init() {
    const initialZoom = 0.6;
    const initialPanX = (canvasEl.clientWidth / 2) - (WORLD.w * initialZoom / 2);
    const initialPanY = (canvasEl.clientHeight / 2) - (WORLD.h * initialZoom / 2);
    setTransform({ panX: initialPanX, panY: initialPanY, zoom: initialZoom });
    
    bindEvents();
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    $$('.canvas-node').forEach(nodeEl => {
        const nodeId = nodeEl.dataset.nodeId || '';
        if (nodeId.startsWith('image-editor')) initializeImageEditorNode(nodeEl);
        else if (nodeId.startsWith('image-upload')) initializeImageUploadNode(nodeEl);
    });

    $(`.top-toolbar__button[data-tool="${state.activeTool}"]`)?.click();
    renderMinimap(); // Initial render of the minimap
    console.log("Canvas ready.");
}

init();