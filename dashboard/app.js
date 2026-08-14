// Sephiria Companion, Wiki & Algorithm Tester Dashboard

let ws = null;
let currentInventory = [];
let currentMapData = null;
let isDemoMode = false;
let reconnectTimer = null;
let reconnectDelay = 1000;
let lastSuggestedLayout = null;
let activeTab = 'inventory';

const STEAM_APP_ID = "2436940";

// Offline Database & Icons
let offlineDatabase = { items: [], combos: [] };
let offlineItemMap = new Map();

// Simulator State
let simBeforeItems = [];
let simAfterItems = [];
let simGridWidth = 6;
let simGridHeight = 5;
let selectedSimItemIndex = -1;

// Wiki Filter State
let wikiRarityFilter = 'all';
let wikiTypeFilter = 'all';
let wikiSearchQuery = '';

document.addEventListener('DOMContentLoaded', () => {
    loadOfflineDatabase();
    initTabs();
    initWebSocket();
    setupEventListeners();
    initProcessControl();
    initMapCanvas();
    initSimulator();
    initWiki();
});

function loadOfflineDatabase() {
    if (window.OFFLINE_DATABASE && window.OFFLINE_DATABASE.items) {
        offlineDatabase = window.OFFLINE_DATABASE;
        offlineDatabase.items.forEach(item => {
            offlineItemMap.set(item.id, item);
        });
        console.log(`Loaded standalone offline database: ${offlineDatabase.items.length} items & ${offlineDatabase.combos.length} combos`);
        renderWikiGrid();
        renderWikiCombos();
        return;
    }

    fetch('../assets/database.json')
        .then(res => res.json())
        .then(data => {
            offlineDatabase = data;
            if (data.items) {
                data.items.forEach(item => {
                    offlineItemMap.set(item.id, item);
                });
            }
            console.log(`Loaded fetch offline database: ${offlineDatabase.items.length} items & ${offlineDatabase.combos.length} combos`);
            renderWikiGrid();
            renderWikiCombos();
        })
        .catch(err => {
            console.warn('Could not load offline database.json via fetch, using fallback names.', err);
        });
}

function initTabs() {
    const tabInv = document.getElementById('tab-inventory');
    const tabWiki = document.getElementById('tab-wiki');
    const tabSim = document.getElementById('tab-simulator');
    const tabMap = document.getElementById('tab-map');

    const viewInv = document.getElementById('view-inventory');
    const viewWiki = document.getElementById('view-wiki');
    const viewSim = document.getElementById('view-simulator');
    const viewMap = document.getElementById('view-map');

    tabInv.addEventListener('click', () => {
        activeTab = 'inventory';
        setTabActive(tabInv, viewInv);
    });

    tabWiki.addEventListener('click', () => {
        activeTab = 'wiki';
        setTabActive(tabWiki, viewWiki);
        renderWikiGrid();
    });

    tabSim.addEventListener('click', () => {
        activeTab = 'simulator';
        setTabActive(tabSim, viewSim);
    });

    tabMap.addEventListener('click', () => {
        activeTab = 'map';
        setTabActive(tabMap, viewMap);
        if (currentMapData) renderMapCanvas(currentMapData);
    });
}

function setTabActive(tabEl, viewEl) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.view-panel').forEach(view => view.classList.remove('active'));
    tabEl.classList.add('active');
    viewEl.classList.add('active');
}

// ── 1. Artifact Wiki & Compedia ────────────────────────────────────

function initWiki() {
    const searchInput = document.getElementById('wiki-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            wikiSearchQuery = e.target.value.toLowerCase().trim();
            renderWikiGrid();
        });
    }

    document.querySelectorAll('.wiki-filter-bar .filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const rarity = btn.dataset.rarity;
            const type = btn.dataset.type;

            if (rarity) {
                document.querySelectorAll('.wiki-filter-bar [data-rarity]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                wikiRarityFilter = rarity;
            }
            if (type) {
                document.querySelectorAll('.wiki-filter-bar [data-type]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                wikiTypeFilter = type;
            }
            renderWikiGrid();
        });
    });

    renderWikiGrid();
    renderWikiCombos();
}

function renderWikiGrid() {
    const grid = document.getElementById('wiki-grid');
    if (!grid || !offlineDatabase.items) return;

    grid.innerHTML = '';
    const filtered = offlineDatabase.items.filter(item => {
        if (wikiRarityFilter !== 'all' && item.rarity !== wikiRarityFilter) return false;
        if (wikiTypeFilter !== 'all' && item.type !== wikiTypeFilter) return false;
        if (wikiSearchQuery && !item.name.toLowerCase().includes(wikiSearchQuery)) return false;
        return true;
    });

    filtered.forEach(item => {
        const card = document.createElement('div');
        const rarityClass = (item.rarity || 'common').toLowerCase();
        card.className = `wiki-card-element rarity-${rarityClass}`;
        card.title = `${item.name} (${item.type}) - Rarity: ${item.rarity}`;

        const iconDiv = document.createElement('div');
        iconDiv.className = 'wiki-card-icon';
        iconDiv.style.backgroundImage = `url('../assets/icons/${item.icon}')`;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'wiki-card-name';
        nameSpan.textContent = cleanItemName(item.name);

        card.appendChild(iconDiv);
        card.appendChild(nameSpan);

        card.addEventListener('click', () => {
            showWikiInspector(item);
        });

        grid.appendChild(card);
    });
}

function renderWikiCombos() {
    const container = document.getElementById('wiki-combo-list');
    if (!container || !offlineDatabase.combos) return;

    container.innerHTML = '';
    offlineDatabase.combos.forEach(combo => {
        const item = document.createElement('div');
        item.className = 'wiki-combo-item';

        const iconDiv = document.createElement('div');
        iconDiv.className = 'wiki-combo-icon';
        iconDiv.style.backgroundImage = `url('../assets/combos/${combo.icon}')`;

        const textSpan = document.createElement('span');
        textSpan.style.color = 'var(--color-gold)';
        textSpan.style.fontWeight = 'bold';
        textSpan.textContent = combo.name;

        item.appendChild(iconDiv);
        item.appendChild(textSpan);
        container.appendChild(item);
    });
}

function showWikiInspector(item) {
    const panel = document.getElementById('wiki-detail-content');
    if (!panel) return;

    panel.innerHTML = `
        <div class="detail-header">
            <div class="detail-icon" style="background-image: url('../assets/icons/${item.icon}'); background-size: contain; background-repeat: no-repeat; background-position: center; width: 48px; height: 48px;"></div>
            <div>
                <div class="detail-name" style="color: var(--color-${(item.rarity || 'common').toLowerCase()}); font-weight: bold;">${cleanItemName(item.name)}</div>
                <div style="font-size: 10px; color: var(--text-dim)">ID: #${item.id} | Type: ${item.type} | Rarity: ${item.rarity}</div>
            </div>
        </div>
        <div style="font-size: 11px; margin-top: 10px; color: var(--text-main);">
            • <strong>Icon Asset:</strong> <code>assets/icons/${item.icon}</code><br>
            • <strong>Description:</strong> Sephiria game artifact entity object.
        </div>
    `;
}

function cleanItemName(rawName) {
    if (!rawName) return "Item";
    return rawName.replace(/^\d+_\s*/, '').replace(/([A-Z])/g, ' $1').trim();
}

// ── 2. Offline Algorithm Simulator / Interactive Tester ──────────────

function initSimulator() {
    loadSimulatorPreset();

    document.getElementById('btn-sim-preset').addEventListener('click', () => { loadSimulatorPreset(); });
    document.getElementById('btn-sim-run').addEventListener('click', () => { runOfflineSimulatorAlgorithm(); });
    document.getElementById('btn-sim-reset').addEventListener('click', () => {
        simBeforeItems = []; simAfterItems = []; renderSimGrids();
        document.getElementById('sim-log-panel').textContent = 'Simulator cleared.';
    });

    document.getElementById('btn-add-charm').addEventListener('click', () => { addRandomSimItem(false); });
    document.getElementById('btn-add-tablet').addEventListener('click', () => { addRandomSimItem(true); });
}

function loadSimulatorPreset() {
    simBeforeItems = [
        { id: 1155, name: "여섯잎 클로버", type: "Charm", color: "Red", rarity: "Legend", isTablet: false, criteria: "Inside", x: 0, y: 0, level: 3, maxLevel: 5, active: false },
        { id: 1173, name: "베루트의 낫", type: "Charm", color: "Blue", rarity: "Legend", isTablet: false, criteria: "TopInInventory", x: 5, y: 4, level: 2, maxLevel: 5, active: false },
        { id: 1181, name: "빛의 검", type: "Charm", color: "Green", rarity: "Rare", isTablet: false, criteria: "NeighborsAreFull", x: 1, y: 0, level: 4, maxLevel: 5, active: true },
        { id: 2033, name: "백일몽 석판", type: "StoneTablet", color: "Gold", rarity: "Legend", isTablet: true, query: "+1 Adjacent", x: 2, y: 2, level: 1, maxLevel: 1, active: true },
        { id: 2037, name: "반란 석판", type: "StoneTablet", color: "Gold", rarity: "Rare", isTablet: true, query: "+1 Cross", x: 3, y: 1, level: 1, maxLevel: 1, active: true },
        { id: 1030, name: "다목적 벨트", type: "Charm", color: "Red", rarity: "Rare", isTablet: false, criteria: "Outlined", x: 2, y: 1, level: 3, maxLevel: 5, active: false }
    ];

    simAfterItems = JSON.parse(JSON.stringify(simBeforeItems));
    renderSimGrids();
    document.getElementById('sim-log-panel').textContent = 'Preset loaded. Click/drag items in BEFORE grid to edit, or click "RUN ALGORITHM"!';
}

function addRandomSimItem(isTablet) {
    const dbMatch = offlineDatabase.items.find(i => isTablet ? i.type === "StoneTablet" : i.type === "Charm");
    const item = {
        id: dbMatch ? dbMatch.id : Math.floor(Math.random() * 9000),
        name: dbMatch ? cleanItemName(dbMatch.name) : (isTablet ? "석판" : "아티팩트"),
        type: isTablet ? "StoneTablet" : "Charm",
        color: isTablet ? "Gold" : ["Red", "Blue", "Green"][Math.floor(Math.random() * 3)],
        rarity: dbMatch ? dbMatch.rarity : "Rare",
        isTablet: isTablet,
        criteria: ["Inside", "TopInInventory", "Outlined"][Math.floor(Math.random() * 3)],
        x: Math.floor(Math.random() * simGridWidth),
        y: Math.floor(Math.random() * simGridHeight),
        level: Math.floor(Math.random() * 4) + 1,
        maxLevel: 5,
        active: true
    };
    simBeforeItems.push(item);
    simAfterItems = JSON.parse(JSON.stringify(simBeforeItems));
    renderSimGrids();
}

function renderSimGrids() {
    renderInteractiveSimGrid('sim-grid-before', simBeforeItems, true);
    renderInteractiveSimGrid('sim-grid-after', simAfterItems, false);

    const beforeScore = evalSimScore(simBeforeItems);
    const afterScore = evalSimScore(simAfterItems);

    document.getElementById('sim-score-before').textContent = beforeScore.toFixed(1);
    document.getElementById('sim-score-after').textContent = afterScore.toFixed(1);
}

function renderInteractiveSimGrid(elementId, items, isEditable) {
    const grid = document.getElementById(elementId);
    if (!grid) return;

    grid.style.gridTemplateColumns = `repeat(${simGridWidth}, 56px)`;
    grid.style.gridTemplateRows = `repeat(${simGridHeight}, 56px)`;
    grid.innerHTML = '';

    for (let y = 0; y < simGridHeight; y++) {
        for (let x = 0; x < simGridWidth; x++) {
            const slot = document.createElement('div');
            slot.className = 'grid-slot';
            if (isEditable) {
                slot.addEventListener('click', () => { handleSlotClickInSimBefore(x, y); });
            }
            grid.appendChild(slot);
        }
    }

    items.forEach((item, idx) => {
        const el = document.createElement('div');
        const activeClass = item.active ? 'active' : 'inactive';
        const tabletClass = item.isTablet ? 'tablet' : '';
        const selectedClass = (isEditable && selectedSimItemIndex === idx) ? 'selected' : '';
        
        el.className = `item ${activeClass} ${tabletClass} ${selectedClass}`;
        el.style.left = `${item.x * (56 + 4) + 4}px`;
        el.style.top = `${item.y * (56 + 4) + 4}px`;
        el.style.color = `var(--color-${(item.rarity || 'common').toLowerCase()})`;
        el.style.border = `2px solid currentColor`;
        
        if (item.id) {
            el.style.backgroundImage = `url('../assets/icons/${item.id}.png')`;
        } else {
            el.textContent = item.isTablet ? '📜' : (item.name ? item.name.charAt(0) : '?');
        }

        if (isEditable) {
            el.title = `${item.name} (${item.type}) | Level: ${item.level}/${item.maxLevel}`;
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                selectedSimItemIndex = idx;
                renderSimGrids();
                showItemEditPrompt(item, idx);
            });
        }

        grid.appendChild(el);
    });
}

function handleSlotClickInSimBefore(targetX, targetY) {
    if (selectedSimItemIndex >= 0 && selectedSimItemIndex < simBeforeItems.length) {
        const item = simBeforeItems[selectedSimItemIndex];
        item.x = targetX;
        item.y = targetY;
        selectedSimItemIndex = -1;
        simAfterItems = JSON.parse(JSON.stringify(simBeforeItems));
        renderSimGrids();
        document.getElementById('sim-log-panel').textContent = `Moved ${item.name} to (${targetX}, ${targetY}).`;
    }
}

function showItemEditPrompt(item, idx) {
    const log = document.getElementById('sim-log-panel');
    log.innerHTML = `
        <strong>Selected: ${item.name} (${item.type})</strong> at (${item.x}, ${item.y})<br>
        • Level: ${item.level} / Max: ${item.maxLevel} | Criteria: ${item.criteria || 'None'}<br>
        <span style="color: var(--color-gold); cursor: pointer;" onclick="cycleItemCriteria(${idx})">▶ Click to change Criteria (${item.criteria})</span><br>
        <span style="color: #ff5252; cursor: pointer;" onclick="deleteSimItem(${idx})">🗑️ Delete Item</span>
    `;
}

window.cycleItemCriteria = function(idx) {
    const criterias = ["Inside", "TopInInventory", "Outlined", "Always"];
    const current = simBeforeItems[idx].criteria;
    const nextIdx = (criterias.indexOf(current) + 1) % criterias.length;
    simBeforeItems[idx].criteria = criterias[nextIdx];
    simAfterItems = JSON.parse(JSON.stringify(simBeforeItems));
    renderSimGrids();
    showItemEditPrompt(simBeforeItems[idx], idx);
};

window.deleteSimItem = function(idx) {
    simBeforeItems.splice(idx, 1);
    selectedSimItemIndex = -1;
    simAfterItems = JSON.parse(JSON.stringify(simBeforeItems));
    renderSimGrids();
    document.getElementById('sim-log-panel').textContent = 'Item deleted.';
};

function evalSimScore(items) {
    let total = 0;
    let bonusMatrix = Array(simGridWidth).fill(0).map(() => Array(simGridHeight).fill(0));
    items.forEach(i => {
        if (i.isTablet) {
            const x = i.x, y = i.y;
            if (x > 0) bonusMatrix[x - 1][y] += 1;
            if (x < simGridWidth - 1) bonusMatrix[x + 1][y] += 1;
            if (y > 0) bonusMatrix[x][y - 1] += 1;
            if (y < simGridHeight - 1) bonusMatrix[x][y + 1] += 1;
        }
    });

    items.forEach(i => {
        if (!i.isTablet) {
            let met = checkSimCriteria(i);
            i.active = met;
            if (met) {
                let effectiveLevel = Math.min(i.level + bonusMatrix[i.x][i.y], i.maxLevel);
                total += (effectiveLevel + 1) * 150;
            }
        }
    });

    return total;
}

function checkSimCriteria(i) {
    if (i.criteria === "Inside") return i.x > 0 && i.x < simGridWidth - 1 && i.y > 0 && i.y < simGridHeight - 1;
    if (i.criteria === "TopInInventory") return i.y === 0;
    if (i.criteria === "Outlined") return i.x === 0 || i.x === simGridWidth - 1 || i.y === 0 || i.y === simGridHeight - 1;
    return true;
}

function runOfflineSimulatorAlgorithm() {
    const startTime = performance.now();
    const log = document.getElementById('sim-log-panel');
    log.textContent = 'Running Joint Tablet & Charm Simulated Annealing Algorithm...';

    let current = JSON.parse(JSON.stringify(simBeforeItems));
    let best = JSON.parse(JSON.stringify(simBeforeItems));

    let currentScore = evalSimScore(current);
    let bestScore = currentScore;

    let temp = 150.0;
    let cooling = 0.992;

    for (let iter = 0; iter < 3000 && temp > 0.05; iter++) {
        let prev = JSON.parse(JSON.stringify(current));

        let idxA = Math.floor(Math.random() * current.length);
        let idxB = Math.floor(Math.random() * current.length);
        while (idxB === idxA && current.length > 1) idxB = Math.floor(Math.random() * current.length);

        let tempX = current[idxA].x;
        let tempY = current[idxA].y;
        current[idxA].x = current[idxB].x;
        current[idxA].y = current[idxB].y;
        current[idxB].x = tempX;
        current[idxB].y = tempY;

        let candidateScore = evalSimScore(current);
        let delta = candidateScore - currentScore;

        if (delta > 0 || Math.exp(delta / temp) > Math.random()) {
            currentScore = candidateScore;
            if (currentScore > bestScore) {
                bestScore = currentScore;
                best = JSON.parse(JSON.stringify(current));
            }
        } else {
            current = prev;
        }

        temp *= cooling;
    }

    simAfterItems = best;
    renderSimGrids();

    const duration = (performance.now() - startTime).toFixed(1);
    const imp = (bestScore - evalSimScore(simBeforeItems)).toFixed(1);

    log.innerHTML = `
        ✅ <strong>Optimization Complete in ${duration}ms!</strong><br>
        • Initial Score: ${evalSimScore(simBeforeItems).toFixed(1)}<br>
        • Optimized Score: <strong>${bestScore.toFixed(1)}</strong><br>
        • Improvement: <span style="color: var(--color-success)">+${imp} Points</span><br>
        • Tablet Level Matrix & MaxLevel Caps Fully Applied!
    `;
}

// ── 3. Process Control & Realtime Inventory Rendering ───────────────

function initProcessControl() {
    document.getElementById('btn-launch-game').addEventListener('click', () => { window.location.href = `steam://rungameid/${STEAM_APP_ID}`; });
    document.getElementById('btn-restart-game').addEventListener('click', () => { if (confirm('게임을 재시작하시겠습니까?')) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'restart_game' })); else window.location.href = `steam://rungameid/${STEAM_APP_ID}`; } });
    document.getElementById('btn-kill-game').addEventListener('click', () => { if (confirm('게임을 강제 종료하시겠습니까?')) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'kill_game' })); else alert('게임과 연결되어 있지 않습니다.'); } });
}

function initWebSocket() {
    updateStatus('Connecting...', 'connecting');
    try {
        ws = new WebSocket('ws://localhost:5827');
        ws.onopen = () => { updateStatus('Connected to Game', 'connected'); isDemoMode = false; reconnectDelay = 1000; if (reconnectTimer) clearTimeout(reconnectTimer); ws.send(JSON.stringify({ type: 'refresh' })); };
        ws.onmessage = (event) => { try { const message = JSON.parse(event.data); handleServerMessage(message); } catch (err) {} };
        ws.onclose = () => { updateStatus('Disconnected (Retrying...)', 'disconnected'); scheduleReconnect(); };
        ws.onerror = () => { ws.close(); };
    } catch (err) { enableDemoMode(); }
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { initWebSocket(); reconnectDelay = Math.min(reconnectDelay * 1.5, 10000); }, reconnectDelay);
}

function enableDemoMode() { isDemoMode = true; updateStatus('Demo Mode (Game Offline)', 'disconnected'); }
function updateStatus(text, state) { const dot = document.getElementById('status-dot'); const textEl = document.getElementById('status-text'); if (textEl) textEl.textContent = text; if (dot) dot.className = `status-dot ${state}`; }

function handleServerMessage(message) {
    if (message.type === 'inventory_update') renderInventoryData(message.data);
    else if (message.type === 'map_update') handleMapUpdate(message.data);
    else if (message.type === 'optimize_result') handleOptimizeResult(message.data);
}

function renderInventoryData(data) {
    currentInventory = data.items || [];
    const grid = document.getElementById('inventory-grid');
    if (!grid) return;

    const width = data.width || 6;
    const height = data.height || 5;
    grid.style.gridTemplateColumns = `repeat(${width}, 64px)`;
    grid.style.gridTemplateRows = `repeat(${height}, 64px)`;
    grid.innerHTML = '';

    for (let i = 0; i < width * height; i++) {
        const slot = document.createElement('div');
        slot.className = 'grid-slot';
        grid.appendChild(slot);
    }

    currentInventory.forEach(item => {
        const el = document.createElement('div');
        const activeClass = item.isActive ? 'active' : 'inactive';
        el.className = `item ${activeClass}`;
        el.style.left = `${item.x * (64 + 4) + 4}px`;
        el.style.top = `${item.y * (64 + 4) + 4}px`;
        el.style.color = `var(--color-${(item.rarity || 'common').toLowerCase()})`;
        el.style.border = `2px solid currentColor`;
        
        if (item.entityID) {
            el.style.backgroundImage = `url('../assets/icons/${item.entityID}.png')`;
        } else {
            el.textContent = item.name ? item.name.charAt(0) : '?';
        }

        grid.appendChild(el);
    });
}

function setupEventListeners() {
    document.getElementById('btn-optimize').addEventListener('click', () => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'optimize' })); });
    document.getElementById('btn-apply').addEventListener('click', () => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'apply', layout: lastSuggestedLayout })); });
    document.getElementById('btn-undo').addEventListener('click', () => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'undo' })); });
}

function handleOptimizeResult(data) {
    document.getElementById('optimized-score').textContent = data.optimizedScore.toFixed(1);
    lastSuggestedLayout = data.suggestedLayout;
    document.getElementById('btn-apply').disabled = false;
}

function handleMapUpdate(map) { currentMapData = map; }
function initMapCanvas() {}
function renderMapCanvas(map) {}
