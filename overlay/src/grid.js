// 인벤토리 격자 렌더러. 최적배치 패널과 팀원 패널이 공유한다.

'use strict';

const { ASSETS, itemById } = require('./gamedata');

/**
 * 인벤토리 스냅샷을 격자 DOM 으로 그린다.
 *
 * 격자는 직사각형이 아니다: Height = ceil(storage / Width) 이므로
 * 마지막 줄은 부분적으로만 존재할 수 있고, 없는 칸은 빗금으로 표시한다.
 * 포션 벨트(y = 100)처럼 격자 밖 슬롯은 제외한다.
 */
function renderGridInto(gridEl, snap) {
  gridEl.innerHTML = '';

  if (!snap) {
    gridEl.style.gridTemplateColumns = '';
    gridEl.innerHTML = '<div class="empty">데이터 없음</div>';
    return;
  }

  const w = snap.width || 6;
  const storage = snap.storage || (w * (snap.height || 6));
  const h = Math.ceil(storage / w);

  gridEl.style.gridTemplateColumns = `repeat(${w}, auto)`;

  const byPos = {};
  for (const it of (snap.items || [])) {
    if (it.x < 0 || it.x >= w || it.y < 0 || it.y >= h) continue;
    if (it.y * w + it.x >= storage) continue;
    byPos[`${it.x},${it.y}`] = it;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell';

      if (y * w + x >= storage) {
        cell.classList.add('void');
        gridEl.appendChild(cell);
        continue;
      }

      const it = byPos[`${x},${y}`];
      if (it) {
        const db = itemById(it.entityID);
        const isTablet = db && db.type === 'StoneTablet';
        const rarity = (it.rarity || db?.rarity || 'Common').toLowerCase();

        cell.classList.add(`rarity-${rarity}`);
        if (isTablet) cell.classList.add('tablet');
        if (it.isActive === false) cell.classList.add('inactive');

        // 커스텀 툴팁 데이터 바인딩 (최적배치 격자 호버 시 상세 툴팁 노출)
        cell.dataset.cat = 'artifacts';
        cell.dataset.id = String(it.entityID);
        cell.dataset.name = it.name || db?.name || '';
        cell.dataset.level = String(it.level != null ? it.level : 0);
        cell.dataset.maxLevel = String(it.maxLevel != null ? it.maxLevel : (db?.maxLevel || 0));
        cell.dataset.rarity = it.rarity || db?.rarity || 'Common';
        if (it.activateCriteria && it.activateCriteria !== 'Always') {
          cell.dataset.criteria = it.activateCriteria;
          cell.dataset.criteriaDesc = it.criteriaDescription || '';
        }
        cell.dataset.active = it.isActive !== false ? 'true' : 'false';

        const img = document.createElement('img');
        img.src = `${ASSETS}/icons/${it.entityID}.png`;
        img.onerror = () => { img.style.visibility = 'hidden'; };
        cell.appendChild(img);

        // 마법서는 책 표지 위에 담긴 마법의 아이콘을 겹쳐 그린다 (게임 인게임 UI 와 동일)
        const magicIcon = db?.magicIcon || (db?.isMagicBook ? `${it.entityID}_magic.png` : null);
        if (magicIcon) {
          const overlay = document.createElement('img');
          overlay.className = 'magic-overlay';
          overlay.src = `${ASSETS}/icons/${magicIcon}`;
          overlay.onerror = () => overlay.remove();
          cell.appendChild(overlay);
        }

        if (!isTablet) {
          const lv = document.createElement('span');
          lv.className = 'lv';
          lv.textContent = it.level;
          cell.appendChild(lv);
        }
      }

      gridEl.appendChild(cell);
    }
  }
}

module.exports = { renderGridInto };
