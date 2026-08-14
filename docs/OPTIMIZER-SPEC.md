# IMPLEMENTATION SPEC — `CustomArrangementOptimizer.cs` rewrite

**Scope:** full replacement of `C:/Users/user/git_default/SephiriaPlugin/SephiriaPlugin/CustomArrangementOptimizer.cs`, plus additive changes to `DataCollector.cs` / `Models.cs`. Every mechanical claim below is cited to decompiled source at
`C:/Users/user/AppData/Local/Temp/claude/C--Users-user-git-default-SephiriaPlugin/5bec56ed-8624-48d0-98b5-1791374af4db/scratchpad/decomp/`.
Findings whose adversarial verification returned `refuted:true` are used **only** in their corrected form.

---

## 0. What is wrong with the current file (why a rewrite, not a patch)

| Line | Defect | Ground truth |
|---|---|---|
| `CustomArrangementOptimizer.cs:262-274` `ApplyVirtualTabletLevels` | "+1 to the 4 orthogonal neighbours" is fabricated. No such rule exists in the assembly. | Tablet effects are a 47-keyword text DSL parsed by `StoneTablet.ParseQuery` (`StoneTablet.cs:542-2265`). |
| `:174` `tabletRotation = (r + 90) % 360` | Rotation is stored in degrees. | `StoneTablet.rotation` is a quarter-turn **index 0..3** (`StoneTablet.cs:194`; `Rotate()` at `StoneTablet.cs:2411-2425` cycles 0→1→2→3→0). Feeding 90/180/270 into `ParseQuery` hits no `case` and silently emits nothing. |
| `:239-240` `Math.Max(0, Math.Min(width-1, x))` | Clamping invents cells in the ragged last row. | Valid cell ⟺ `0<=x<Width && 0<=y<Height && PosToIdx(pos) < CurrentInventoryStorage` (`GridInventory.cs:2858-2864`). |
| `:246` `int baseLevel = charm.DisplayedLevel` | `DisplayedLevel` is `levelMatrix[pos]` and **already contains every tablet/engraving/enchant contribution** (`Charm_Basic.cs:113-124`). Adding a virtual tablet bonus double-counts. | Base = `dungeonTempLevels[cell] + Enchant(instanceID)` only. |
| `:278-303` `CheckVirtualCriteria` | 5 of 10 criteria implemented, 4 of the 5 wrong, other 5 silently `return true`. | See §2.4. |
| `:47`,`:92` mixing `EvaluateCurrentAutoArrangeScore()` with `EvaluateVirtualJointFitness` | Different units; `improvement` is meaningless. `EvaluateCurrentAutoArrangeScore` also reads **only live state** and is `[Server]`-gated (returns `0f` silently otherwise, `GridInventory.cs:4695-4701`). | Compute the initial score with the *same* virtual objective. |
| whole search loop | Dereferences `NewItemOwnInstance` / `Charm_Basic` (Unity objects, `Entity` does an `ItemDatabase` lookup — `NewItemOwnInstance.Entity => ItemDatabase.FindItemById(EntityID)`). | Cannot run off the main thread. |
| `:230` swaps only among occupied slots | An item can never move into an empty cell. | Slot model must include empties. |
| missing | `Disable`, `IgnoreCriteria`, `MultiplyConstLevel`, tablet activation criteria, combos. | §3. |

---

## 1. Data model — the immutable snapshot

All search-thread code must see **only** these plain types. No `UnityEngine.Object`, no `SyncDictionary`, no `NewItemOwnInstance`, no string parsing.

### 1.1 Geometry

```csharp
internal sealed class GridGeometry {
    public readonly int Width;    // GridInventory.Width      (byte, GridInventory.cs:148)
    public readonly int Storage;  // CurrentInventoryStorage  (short, GridInventory.cs:145)
    public readonly int Height;   // = ceil(Storage / Width)  (GridInventory.cs:436-439)

    public int  Idx(int x,int y) => y * Width + x;             // GridInventory.cs:3116
    public int  X(int i) => i % Width;                          // GridInventory.cs:3126
    public int  Y(int i) => i / Width;
    public bool IsCell(int x,int y) =>                          // GridInventory.cs:2858-2864
        x>=0 && x<Width && y>=0 && y<Height && Idx(x,y) < Storage;
}
```

Read `Width` live — do **not** hardcode 6. (`MaxWidth`/`MaxHeight` at `GridInventory.cs:134/136` are dead consts with zero other references; nothing enforces them.)

Slot index space is `[0, Storage)` — exactly what the game's own capture loop uses (`GridInventory.cs:4761-4763`). The last row is normally partial: `AddStorage` takes an arbitrary `short` (`GridInventory.cs:534`, `:595`) and `LocalAddStorage` only fires `RpcChangeInventoryHeight` when `Height` actually changes (`GridInventory.cs:593-600`), proving partial rows are the expected state.

### 1.2 Items

```csharp
internal enum SlotKind : byte { Misc = 0, Charm = 1, Tablet = 2 }

internal enum CriteriaKind : byte {
    None = 0, TopInInventory, BottomInInventory, Inside, Outlined, SideEnd,
    BothSideCharm, BothSidesAreEmpty, NeighborsAreFull, Near8MagicBook,
    FullHP, Unknown
}

internal enum CategoryRule : byte { Static = 0, RowElemental = 1, WhitePaper = 2, UpCharmChain = 3 }

internal sealed class SnapItem {
    public int      InstanceID;
    public int      EntityID;
    public string   Name;            // display only
    public SlotKind Kind;
    public bool     IsEItemTypeCharm;// Entity.type == EItemType.Charm — needed by BothSideCharm
    public bool     IsMagicBook;     // Charm is Charm_Magic — needed by Near8MagicBook
    public int      HomeIdx;         // current linear index; -1 if not on the main grid
    public bool     Movable;         // see §2.1

    // --- charm-only ---
    public int          MaxLevel;        // Charm_Basic.maxLevel (default 5, Charm_Basic.cs:46)
    public int          EnchantLevel;    // item-bound, travels with the charm; see §1.4
    public CriteriaKind Criteria;
    public bool         IsWeaponRelated; // Charm_Basic.isWeaponRelatedCharm
    public bool         WeaponMatches;   // PRE-EVALUATED, fixed truth; see §2.5
    public bool         IsUniqueEffect;
    public string[]     StaticCategories;// ItemEntity.categories (ItemEntity.cs:22)
    public CategoryRule CatRule;         // §4.1
    public byte         CalcOrder;       // 0=Pre,1=Default,2=Post (ECharmCalculationOrder)
    public string[]     RowElementalLine;// Charm_3Elemental_ByRow.lineCategory, if CatRule==RowElemental
    public int          WhitePaperMatch; // Charm_WhitePaper.match, if CatRule==WhitePaper
    public sbyte        ChainDx, ChainDy;// Charm_UpCharmDamage.xOffset/yOffset, if CatRule==UpCharmChain

    // --- tablet-only ---
    public int  Rotation;      // 0..3, live value
    public bool Rotatable;     // DungeonManager.IsTabletRotatable(instanceID, isRotatable)
    public int  PatternBase;   // index into TabletPatternTable, see §1.3
}
```

`IsMagicBook` must be captured on the main thread as `item.Charm is Charm_Magic` (`CharmActivateCriteria_Near8MagicBook.cs:21`). `Charm_Magic` has no subclasses, so an exact type-name check is equivalent.

### 1.3 Tablet pattern table — the single most important precomputation

`StoneTablet.ParseQuery` is `public static` and pure (`StoneTablet.cs:542`); its only external calls are `GridInventory.IdxToPos/PosToIdx` static overloads (`GridInventory.cs:3131-3138`), which are pure arithmetic. It returns **absolute** grid positions with rotation already applied (`case "O"` → `new ItemPosition(originPos.x, originPos.y)` at `:552`; `case "LEFT"` rot0 → `(x-1, y)` at `:574`).

> **Do not** feed `GetRotatedQuery` output into `ParseQuery` with a nonzero `rotation` — that double-rotates. `ApplyEffect` passes the *raw* query plus the rotation int (`StoneTablet.cs:374`, `:416`). Mirror that exactly.

Precompute on the **main thread**, during snapshot, for every tablet × every legal rotation × every candidate origin `i ∈ [0, Storage)`:

```csharp
internal enum EffOp : byte { Increase = 1, Disable = 2, IgnoreCriteria = 3, Multiply = 4 }
internal enum CritOp: byte { AnyItem = 1, OnlyCharm = 2 }

internal struct EffCell  { public int Idx;  public EffOp  Op; public int Param; }
internal struct CritCell { public int Idx;  public CritOp Op; }   // Idx = -1 ⇒ off-grid ⇒ always empty ⇒ criterion FAILS

internal sealed class TabletPattern {
    public EffCell[]  Effects;          // targets outside [0,Storage) DROPPED
    public CritCell[] Criteria;         // targets outside [0,Storage) KEPT as Idx = -1
    public bool       PlacedDeclared;   // any CriteriaType.Placed line present
    public bool       PlacedSatisfied;  // some Placed line resolved to the origin cell itself
    public bool       StaticallyDead;   // PlacedDeclared && !PlacedSatisfied  ⇒ tablet inert here
}
// TabletPatternTable[ PatternBase + rot * Storage + originIdx ]
```

Build procedure per `(tablet, rot, origin)`:

```
originPos = new ItemPosition((sbyte)geo.X(origin), (sbyte)geo.Y(origin));

// --- effects ---
foreach (md in StoneTablet.ParseQuery(tablet.GetQuery(tablet.instanceID),
                                      W, H, Storage, originPos, rot, out _)) {
    var e = new StoneTablet.AdditionEffectData(md);          // StoneTablet.cs:124-168
    if (e.effectType == StoneTablet.EffectType.None) continue;   // logged error, no matrix write
    if (!geo.IsCell(md.position.x, md.position.y)) continue;     // can never reach a real charm
    emit { Idx = geo.Idx(x,y), Op = map(e.effectType), Param = e.levelParam };
}

// --- criteria ---
foreach (md in StoneTablet.ParseQuery(tablet.GetConditionQuery(tablet.instanceID),
                                      W, H, Storage, originPos, rot, out _)) {
    var c = new StoneTablet.AdditionCriteriaData(md);         // StoneTablet.cs:75-93
    switch (c.effectType) {
      case AnyItem:   emit { Idx = geo.IsCell(p) ? geo.Idx(p) : -1, Op = AnyItem   }; break;
      case OnlyCharm: emit { Idx = geo.IsCell(p) ? geo.Idx(p) : -1, Op = OnlyCharm }; break;
      case Placed:    PlacedDeclared = true;
                      PlacedSatisfied |= (md.position.x == originPos.x &&
                                          md.position.y == originPos.y); break;
      case None:      /* auto-pass AND sets the placed-satisfied flag — see below */
                      PlacedSatisfied = true; break;
    }
}
```

Four traps a naive implementation hits:

1. **Off-grid criteria must be kept, off-grid effects must be dropped.** `ApplyEffect` does no bounds check. An effect at `(-1,3)` writes `levelMatrix[ItemPosition(-1,3)]`, a key that never collides with a real cell (`ItemPosition.GetHashCode = x^(y<<2)`, componentwise `==`) — harmless, drop it. A criterion at `(-1,3)` calls `FindItem(-1,3)` → `null` → the criterion **fails** (`StoneTablet.cs:383-390`). Dropping it silently activates tablets that should be off.
2. **Never map an off-grid position through `PosToIdx`.** `PosToIdx(-1,3) = 17`, a perfectly valid but completely wrong cell. Bounds-check with `IsCell` *before* converting.
3. **`CriteriaType.None` is not inert.** `StoneTablet.cs:398-401` `default: flag4 = true; flag5 = true;` — it auto-passes the AND-chain **and** sets `flag3`, which can mask a failing `PLACED` requirement at the gate (`:405`). Model it as `PlacedSatisfied = true`.
4. **`IDX`/`RIDX` are three-token lines.** `IDX <index> <value>` / `RIDX <index> <value>` — value is `array2[2]`, not `array2[1]` (`StoneTablet.cs:555-568`; `RIDX` uses `storage - 1 - n`). This only matters if you reimplement the parser. **Don't** — call the real `StoneTablet.ParseQuery` and the real `AdditionEffectData`/`AdditionCriteriaData` constructors. That is the highest-fidelity option and eliminates all 47 keyword cases and all rotation handedness questions.

Cost: `nTablets × 4 × Storage` ParseQuery calls. At 8 tablets / 30 slots that's 960 calls of a small string parse — single-digit milliseconds, once per snapshot.

**Engravings** (`GridInventory.engravings`, `SyncList<StoneTablet>`, `GridInventory.cs:178`) are tablets that do **not** occupy a cell but still call `ApplyEffect()` (`GridInventory.cs:2669-2672`). Snapshot each with its **fixed** `(xIdx, yIdx, rotation)` — one pattern each, `Movable = false`, not part of the permutation — but still re-evaluate its criteria per candidate, because `AnyItem`/`OnlyCharm` read occupancy.

### 1.4 Fixed / cell-bound seeds

```csharp
internal sealed class Seeds {
    public int[]  DungeonTempLevel;   // len Storage, from GridInventory.dungeonTempLevels
    public int[]  FixedLevel;         // Σ over fixedEngravingsOnServer[i].fixedLevel
    public int[]  FixedIgnore;        //   .fixedIgnoreCriteria
    public int[]  FixedDisable;       //   .fixedDisable
    public int[]  FixedMultiply;      //   .fixedMultiplyLevel
    public bool[] EverHadDisableKey;  // = live disableMatrix.Keys ∩ [0,Storage)   — see §3.4
    public int    GlobalActiveValue;  // GridInventory.globalActiveValue (GridInventory.cs:169, default 1)
    public bool   EnableCharmEffects; // GridInventory.enableCharmEffects (:201)
}
```

`dungeonTempLevels` is the one level source that is **cell-bound and survives the teardown**: `GetPermission` (`GridInventory.cs:2470-2560`) un-multiplies, removes every tablet/engraving/fixed-engraving contribution and subtracts each charm's Enchant, but never touches `dungeonTempLevels`, which was folded into `levelMatrix` by `AddDungeonTempLevel` (`GridInventory.cs:442-461`). So it is exactly the residual base of each cell.

**Enchant** is *item-bound*: `ReleasePermission` re-adds `DungeonManager.Instance.GetGlobalItemStatValue(charm.Item.InstanceID, "Enchant")` at the charm's **current** cell (`GridInventory.cs:2587-2597`). Snapshot it per charm via `DungeonManager.Instance.GetGlobalItemStatValue(instanceID, "Enchant")` (`ALL.cs:67593`) and `int.TryParse` it; it moves with the charm.

### 1.5 Combo snapshot

```csharp
internal sealed class ComboTable {
    public string[]  CategoryIds;            // ItemDatabase.GetAllItemCategory() → .id
    public int[][]   Thresholds;             // per category, ascending, from the LIVE prefab
    public int[]     BonusCount;             // GridInventory.bonusComboCount
    public int[]     UniquePairExtra;        // §4.3, treated as a layout-invariant constant
    public bool      OverlapDedup;           // DungeonManager.hardModeEnvironment["OVERLAPITEMCOMBO"] > 0
}
```

Thresholds must be read at runtime from the live `ComboEffectBase` — `addStatByCombo[i].comboCount` **union** the subclass-specific int fields, because 7 of 22 categories carry tiers only on the subclass (`ComboEffect_Debuff.debuffActivateComboCount` / `debuffHasteComboCount`, `ComboEffect_DarkCloud.darkCloudComboCount` / `bigCloudComboCount`, `ComboEffect_FlameSword.flameSwordComboCount`, `ComboEffect_Mystic.first` / `second`, `ComboEffect_Alchemy.first` / `second`). `ComboEffectBase.BuildEffectData(avatar).Keys` is the cleanest single source: it merges `addStatByCombo` with the subclass tiers injected by `OnRequestComboData` (`ComboEffectBase.cs:146-220`). Prefer it.

Do **not** hardcode 2/4/6/8/10, and do **not** trust the decompiled C# field initializers — the shipped `ComboEffect_Alchemy` has `first=3, activeSecond=false`, not the source default `first=2, activeSecond=true`. Prefabs reachable via `ItemDatabase.FindItemCategory(id).comboEffectPrefab` (`ItemCategoryEntity.cs:27`), instantiated live at `GridInventory.cs:3466-3473`.

Ignore `ItemCategoryEntity.setStatus` / `GetSetTargetByItemCount` / `GetMinEffect` entirely — zero call sites in the whole assembly; dead legacy data with *different* numbers that will silently corrupt the objective if confused with combo tiers.

### 1.6 The mutable candidate

```csharp
internal struct Layout {          // value-ish; pooled arrays, no allocation in the hot loop
    public int[] SlotToItem;      // len Storage; -1 = empty
    public int[] ItemToSlot;      // len nItems
    public byte[] Rotation;       // len nItems; only meaningful for Kind==Tablet
}
```

Every item occupies exactly one cell — verified: `SetItem` does a single `inventoryMatrix.Add(new ItemPosition(x,y), …)` (`GridInventory.cs:1318`), `ForceRemoveItem` a single `.Remove` (`:1374`), and `NewItemOwnInstance` has no width/height/footprint field. Rotation changes the **effect** footprint, never the **occupied** footprint. So this is a pure permutation problem — no bin packing.

---

## 2. Constraint model

### 2.1 Placement

- Legal cells: `idx ∈ [0, Storage)`. Nothing else.
- **Exclude from the snapshot** anything with `y == 100` (the potion belt lives in the *same* `inventoryMatrix` — `GridInventory.cs:1033`, `:1199`, `:1244`, and `LocalSwap` guards `yRight >= 100` at `:2305-2313`) and anything in `subBagMatrix` (a separate dictionary keyed by `x`, `GridInventory.cs:4029`). `DataCollector` currently enumerates `inventoryMatrix` unfiltered — **this is a live bug**; potion entries are being handed to the optimizer as grid cells.
- Non-charm, non-tablet items (`SlotKind.Misc`) still occupy cells and are visible to `FindItem`, so they materially affect `NeighborsAreFull`, `BothSidesAreEmpty`, `BothSideCharm` and tablet `AnyItem` criteria. Snapshot and permute them.
- No type-based cell restriction exists server-side. `LocalSwap` (`GridInventory.cs:2287-2376`) rejects only non-Potion → potion-row moves. See §7 gap G9 for the client-UI question.
- `Movable = false` for: engravings (not on the grid), and any item the caller pins. Everything on the grid is otherwise movable.
- **Unique-effect charms**: `EnableEffect` early-returns without setting `IsEffectEnabled` if `isUniqueEffect && !Inventory.RegisterUniqueEffect(this)` (`Charm_Basic.cs:528-533`). The inventory already refuses a second copy (`ItemAdditionCheckResult.HasSameUnique`), so in practice this is a no-op — but assert `count(EntityID) <= 1` for unique charms and, if violated, mark all but the first permanently disabled.

### 2.2 Rotation legality

`Rotation` is an **index 0..3**. Legal to change ⟺ `DungeonManager.IsTabletRotatable(instanceID, tablet.isRotatable)` (`ALL.cs:67614-67630`, which consults `overrideTabletRotatable` before the prefab flag). This is exactly the gate the game's own auto-arrange uses (`GridInventory.cs:4633`). If `Rotatable == false`, pin `Rotation` to the snapshotted live value and never mutate it.

### 2.3 Tablet activation (per candidate, per tablet)

Faithful transcription of `StoneTablet.ApplyEffect` (`StoneTablet.cs:374-412`):

```csharp
bool TabletActive(TabletPattern p, Layout L) {
    if (p.Criteria.Length == 0 && !p.PlacedDeclared) return true;   // list.Count == 0 ⇒ unconditional
    bool allHit = true;
    for (int k = 0; k < p.Criteria.Length; k++) {
        var c = p.Criteria[k];
        bool hit;
        if (c.Idx < 0)                      hit = false;            // off-grid ⇒ FindItem == null
        else if (c.Op == CritOp.AnyItem)    hit = L.SlotToItem[c.Idx] >= 0;
        else /* OnlyCharm */ {
            int it = L.SlotToItem[c.Idx];
            hit = it >= 0 && items[it].IsEItemTypeCharm;             // Entity.type == EItemType.Charm
        }
        allHit &= hit;
        if (!allHit) break;
    }
    // gate: if (list.Count != 0 && (!flag || (!flag3 && flag2))) return;
    if (!allHit) return false;
    if (p.PlacedDeclared && !p.PlacedSatisfied) return false;
    return true;
}
```

`PlacedDeclared`/`PlacedSatisfied` are **layout-independent** — precomputed per `(tablet, rot, origin)` in §1.3. Use `StaticallyDead` to prune: a `(tablet, rot, origin)` triple with `StaticallyDead == true` contributes nothing and can be skipped by the mutation operator when the tablet has any live alternative.

`PLACED` is therefore a genuine **placement restriction**: a tablet whose condition query resolves `PLACED` to an absolute region (e.g. `TOP PLACED` → the whole `y==0` row) is only active in that region. Exploit this to shrink the search space.

### 2.4 Charm criteria — all 10, verbatim

The authoritative predicate is `GetCriteria(Charm_Basic)`, called from `Charm_Basic.RefreshCharm` at `Charm_Basic.cs:485` — the **only** call site in the assembly. `IsActivePosition` is UI-only (6 call sites, all in `UI_CharacterStatusPanel` / `UI_CharmTooltip` / `UI_NewInventoryIcon` / `UI_ResultInventoryIcon`) and **diverges** from `GetCriteria` for `SideEnd`, `FullHP` and `BothSidesAreEmpty`. Reimplement `GetCriteria`; never call `IsActivePosition`.

Let `W = Width`, `S = Storage`, `H = Height`, `i = Idx(x,y)`, `num = S % W`.
`Occ(x,y)` = "a cell inside the grid that holds an item" — off-grid always false (`FindItem` is `inventoryMatrix.GetValueOrDefault(pos)` with **no** bounds check, `GridInventory.cs:872-875`).

| # | `CriteriaKind` | Predicate | Source | Layout-dep? |
|---|---|---|---|---|
| 1 | `TopInInventory` | `y == 0` | `CharmActivateCriteria_TopInInventory.cs:5` | position only |
| 2 | `BottomInInventory` | `i >= S - 6` | `..._BottomInInventory.cs:5` | position only |
| 3 | `Inside` | `x>0 && y>0 && x<W-1 && i <= S-8` | `..._Inside.cs:6-13` | position only |
| 4 | `Outlined` | `(x==0 \|\| y==0 \|\| x>=W-1) \|\| i >= S-6` | `..._Outlined.cs:6-13` | position only |
| 5 | `SideEnd` | `x == 0 \|\| x == 5` | `..._SideEnd.cs:5` | position only |
| 6 | `BothSideCharm` | `x>0 && x<W-1 && Occ(x-1,y) && Occ(x+1,y) && both are EItemType.Charm` | `..._BothSideCharm.cs:5-16` | **interacting** |
| 7 | `BothSidesAreEmpty` | `x>0 && x<W-1 && (num==0 \|\| y<H-1 \|\| x<num-1) && !Occ(x-1,y) && !Occ(x+1,y)` | `..._BothSidesAreEmpty.cs:5-12` | **interacting** |
| 8 | `NeighborsAreFull` | all 8 of `(0,1)(1,1)(1,0)(1,-1)(0,-1)(-1,-1)(-1,0)(-1,1)` occupied | `..._NeighborsAreFull.cs:3-27` | **interacting** |
| 9 | `Near8MagicBook` | any of the same 8 offsets holds a charm that `is Charm_Magic` | `..._Near8MagicBook.cs:15-26` | **interacting** |
| 10 | `FullHP` | `avatar.hp == avatar.MaxHp` | `..._FullHP.cs:5` | **FIXED TRUTH** |
| — | `criteria == null` | `true` | `Charm_Basic.cs:485` (`criteria != null &&`) | — |

Notes that will bite:

- **#2/#4 use `S - 6` literally, not `Width`.** With a partial last row the "bottom" band spans two visual rows: at `S=25, W=6`, indices 19..24 = `(1,3)(2,3)(3,3)(4,3)(5,3)(0,4)`. Never model bottom as `y == H-1`.
- **#5 hardcodes `x == 5`, not `W-1`.** Keep the literal 5.
- **#3 and #4 leave a dead zone at `i == S-7`** (interior, satisfies neither). Real, arithmetically verified.
- **#10 `FullHP` is not optimizable.** Snapshot `avatar.hp == avatar.MaxHp` once into `SnapItem.WeaponMatches`-style fixed truth and treat the criterion as a constant. Do not let the search chase it.
- `CriteriaKind.Unknown` (a criterion class not in this list, e.g. added by a patch) must be treated as **fixed-truth**: snapshot the live `charm.IsEffectEnabled` for that charm and freeze it, plus log the type name. Never default it to `true` — that is what the current file does and it silently overvalues those charms.

### 2.5 Non-layout gates (fixed-truth inputs)

From the full activation gate (`Charm_Basic.cs:471-493`), two terms are position-independent and must be snapshotted, not searched:

- `WeaponMatches = !isWeaponRelatedCharm || (WeaponController && WeaponController.currentWeapon && WeaponController.currentWeapon.weaponType == relatedWeapon)` (`Charm_Basic.cs:484`). Note it is **false** when nothing is equipped, not merely on type mismatch.
- `GlobalActiveValue` (`GridInventory.cs:169`).

---

## 3. Effective level computation

This is a from-scratch rebuild of what `GetPermission` undoes and `ReleasePermission` redoes (`GridInventory.cs:2470-2560` / `:2573-2713`). Order below is the *exact* order in `ReleasePermission`.

### 3.1 Algorithm

```
Input: Layout L, Snapshot S
Output: level[Storage], disable[Storage], ignore[Storage], mul[Storage],
        hasLevelKey[Storage], hasDisableKey[Storage], hasIgnoreKey[Storage]

// Step 0 — cell-bound seed (survives the teardown)
level[i]  = S.Seeds.DungeonTempLevel[i];      hasLevelKey[i] = (level[i] != 0) || liveLevelKey[i]
disable[i]= 0; ignore[i] = 0; mul[i] = 0
hasDisableKey[i] = S.Seeds.EverHadDisableKey[i]      // §3.4
hasIgnoreKey[i]  = false

// Step 1 — per-charm base: Enchant, at the charm's CURRENT cell   (GridInventory.cs:2583-2598)
for each charm c:  i = L.ItemToSlot[c];  level[i] += c.EnchantLevel;  hasLevelKey[i] = true

// Step 2 — combo/category resolution (Pre → Default → Post)         (GridInventory.cs:2603-2621)
//          produces effectiveCategories[] per charm; see §4.1.
//          Does NOT touch level/disable/ignore/mul.

// Step 3 — fixed engravings                                        (GridInventory.cs:2622-2668)
level[i]   += S.Seeds.FixedLevel[i];     if (FixedLevel[i]   != 0) hasLevelKey[i]   = true
ignore[i]  += S.Seeds.FixedIgnore[i];    if (FixedIgnore[i]  != 0) hasIgnoreKey[i]  = true
disable[i] += S.Seeds.FixedDisable[i];   if (FixedDisable[i] != 0) hasDisableKey[i] = true
mul[i]     += S.Seeds.FixedMultiply[i]

// Step 4 — cell-occupying tablets, then engravings                 (GridInventory.cs:2669-2675)
for each tablet t (stoneTablets order, then engravings order):
    p = PatternTable[t.PatternBase + L.Rotation[t]*Storage + L.ItemToSlot[t]]   // engraving: fixed slot
    if (!TabletActive(p, L)) continue
    foreach (e in p.Effects) switch (e.Op) {
        Increase:       level[e.Idx]   += e.Param; hasLevelKey[e.Idx]   = true; break;
        Disable:        disable[e.Idx] += 1;       hasDisableKey[e.Idx] = true; break;
        IgnoreCriteria: ignore[e.Idx]  += 1;       hasIgnoreKey[e.Idx]  = true; break;
        Multiply:       mul[e.Idx]     += e.Param; break;    // ADDED into the accumulator
    }

// Step 5 — multiply pass, LAST                                     (GridInventory.cs:2677-2684)
for i in 0..Storage-1:
    if (hasLevelKey[i] && mul[i] != 0) level[i] = level[i] * mul[i];
```

Guarantees, verified:

- **All four accumulators are commutative** (`+=` / `++` only, `StoneTablet.cs:420-466`), and tablet *criteria* read only `inventoryMatrix` occupancy, never the matrices. Therefore tablet iteration order is irrelevant. The `SyncDictionary` enumeration-order open question is moot.
- **`Multiply` is added, then applied once at the end** — two `MUL/2` tablets on one cell give `level * 4`, not `level * 2 * 2` applied twice… actually `mul = 2+2 = 4`, so `level * 4`. Reproduce the accumulate-then-multiply-once shape exactly.
- **`Disable`/`IgnoreCriteria` ignore `levelParam`** — always `++`.
- **`EffectType.None` writes nothing** (no `default:` in the switch at `StoneTablet.cs:420-466`) but is still appended to `EffectRange`. Skip it entirely; it has no gameplay effect.
- `maxLevelMatrix` is written (`GridInventory.cs:2598`) but never read by gameplay — display only. Do not model it.

### 3.2 Per-charm activation

```csharp
bool Enabled(int charm, int i) {
    bool disabled = (S.Seeds.GlobalActiveValue <= 0);
    if (hasDisableKey[i]) disabled = (disable[i] > 0);         // ASSIGNMENT, not OR — Charm_Basic.cs:475-478
    bool ignoreCrit = hasIgnoreKey[i] && ignore[i] > 0;        // Charm_Basic.cs:479-483
    if (disabled)                       return false;
    if (level[i] < 0)                   return false;          // note: 0 PASSES
    if (!ignoreCrit && c.Criteria != CriteriaKind.None && !Criterion(c, i, L)) return false;
    if (!c.WeaponMatches)               return false;          // Charm_Basic.cs:484
    return true;
}
```

Transcribed from `Charm_Basic.cs:485`:
`if (flag || displayedLevel < 0 || (!flag2 && criteria != null && !criteria.GetCriteria(this)) || !flag3) DisableEffect(...) else EnableEffect();`

Three things the old implementation got wrong here: level `0` **passes** (the test is `< 0`, not `<= 0`); `disableMatrix` **overwrites** the global gate rather than OR-ing it; and `ignoreCriteriaMatrix > 0` bypasses the criterion entirely — which is exactly the arrangement-dependent gating an arrangement optimizer exists to model.

### 3.3 Effective strength

```csharp
int rawLevel = level[i];                     // == Charm_Basic.DisplayedLevel
int capped   = Math.Min(c.MaxLevel, rawLevel);
int strength = Enabled(charm,i) ? capped : 0;
```

`capped` is `limitedEffectEnabledLevel` — the value that actually drives effect magnitude (`Charm_Basic.cs:537-539`: `Mathf.Min(maxLevel, DisplayedLevel)`); `DisableEffect` sets it to 0 (`Charm_Basic.cs:600`). Levels above `maxLevel` are worthless except as a tiebreak.

### 3.4 Known fidelity gap — `disableMatrix` key persistence

`StoneTablet.RemoveEffect` decrements `disableMatrix[pos]` to 0 but **keeps the key** (`StoneTablet.cs:498-506`). Because the gate is an assignment, a cell that was *ever* disabled and then un-disabled permanently overrides `globalActiveValue` at that cell. A from-scratch simulation cannot reproduce that path history. Mitigation: seed `EverHadDisableKey` from the live `disableMatrix.Keys` at snapshot time (§1.4). This only matters when `globalActiveValue <= 0`, which is not the normal state (default `1`, `GridInventory.cs:169`). Log a warning if `globalActiveValue <= 0` at snapshot and mark the result "approximate".

---

## 4. Objective function

### 4.1 Effective categories per charm (needed by both modes)

Combo membership is **not** `ItemEntity.categories`. `GridInventory.SearchSetEffectInInventory` counts via the **virtual** `charm.GetItemCategory()` (`GridInventory.cs:3313`), and three subclasses override it with position-dependent values:

| `CategoryRule` | Rule | Source |
|---|---|---|
| `Static` | `ItemEntity.categories` | `Charm_Basic.cs:369-380` |
| `RowElemental` | single category `lineCategory[y % lineCategory.Length]`; the entity's own categories are **discarded** | `Charm_3Elemental_ByRow.cs:95-98`, `:110-114`, `:9` (`{EMBER,GLACIER,MAGITECH}`); `Order = Pre` (`:25`) |
| `WhitePaper` | union of categories held by `>= match` (default 2) of the charms at `(x+1,y)` and `(x-1,y)`; contributes nothing of its own | `Charm_WhitePaper.cs:30-33`, `:112-124`, `:126-164`, `:12`; `Order = Post` (`:14`) |
| `UpCharmChain` | walk `(x+dx, y+dy)` (default `dx=0, dy=-1`) through successive `Charm_UpCharmDamage` links; copy **all** categories of the first non-chain charm found; empty on cycle / empty cell / non-charm | `Charm_UpCharmDamage.cs:148-151`, `:153-194`, `:19-21`; `Order = Default` |

Resolve in `Order` sequence (Pre → Default → Post), matching `value.Sort(CompareByOrder)` at `GridInventory.cs:2607`. Note the consequence: a `UpCharmChain` (Default) terminating on a `WhitePaper` (Post) reads a not-yet-populated set — reproduce that, don't "fix" it.

`RowElemental` assigns its category **before** the `isEnabled` guard (`Charm_3Elemental_ByRow.cs:114-115`), so it contributes to combos even while disabled.

Combo count per category:

```
count[cat] = Σ over placed charms with cat ∈ effectiveCategories(charm)     // +1 each
           + BonusCount[cat]                                                // GridInventory.cs:3445-3457
           + UniquePairExtra[cat]                                           // treated constant, §7 G10
if (OverlapDedup) duplicate EntityIDs collapse to one contribution          // GridInventory.cs:3319-3331
```

Only `EItemType.Charm` items enter `charms` (`GridInventory.cs:1279-1294`) — tablets and misc contribute **zero** to combos regardless of their `ItemEntity.categories`.

Because only three charm classes are position-dependent, **combo counts are almost layout-invariant**. Compute a baseline once, then per candidate recompute only the delta from `RowElemental` / `WhitePaper` / `UpCharmChain` charms. If the bag contains none of the three, combo counts are a constant and drop out of the search entirely.

Tiers are **cumulative**: `ComboEffectBase.Enable` applies **every** `ComboStat` with `comboCount <= count` (`ComboEffectBase.cs:296-313`), not just the highest. `appliedComboEffectCount` is only the max, used for the notification RPC and drop weighting — never for stat magnitude.

```
tiers(cat) = |{ t ∈ Thresholds[cat] : t <= count[cat] }|
```

### 4.2 Mode (a) — combo-max

Input from the dashboard: an **ordered** priority list `P = [p₀, p₁, …]`. Rank weight (default, override-able per entry):

```
w(pₖ) = 1 / (1 + k)        // p₀ = 1.0, p₁ = 0.5, p₂ = 0.333 …
w(cat ∉ P) = 0
```

Per-charm relevance (recomputed per candidate, because `effectiveCategories` can move):

```
rel(c) = REL_BASE + Σ_{cat ∈ effectiveCategories(c)} w(cat)      // REL_BASE = 0.10
```

`REL_BASE > 0` keeps non-priority charms from being treated as free landfill (a disabled off-combo charm is still a wasted slot), but keeps them an order of magnitude below priority charms.

```
Score_comboMax =
      W_LEVEL   * Σ_c  enabled(c) · rel(c) · min(level[i_c], maxLevel_c)
    + W_ON      * Σ_c  enabled(c) · rel(c)
    - W_OFF     * Σ_c (1 − enabled(c)) · rel(c)
    + W_TIER    * Σ_{cat ∈ P} w(cat) · tiers(cat)
    - W_NEG     * Σ_c  max(0, −level[i_c])
    + W_OVER    * Σ_c  max(0,  level[i_c] − maxLevel_c)
```

Default weights, deliberately anchored to the game's own objective (`GridInventory.cs:4734`, `num3*10000 + num*1000 + num4*10 + num5 − num2*750 − num6*250`) so the numbers stay interpretable side-by-side:

```
W_LEVEL = 10000    W_ON = 1000    W_OFF = 750
W_TIER  = 8000     W_NEG = 250    W_OVER = 1
```

`W_OVER = 1` reproduces the game's near-worthless overflow term: it breaks ties toward layouts with headroom without ever outweighing a real level (10000). `W_TIER` at 8000 makes crossing one combo threshold worth roughly one enhancement level on a top-priority charm — tune from telemetry, but keep it in that band.

`f(L) = L` (linear in capped level) is an honest placeholder: the actual per-level magnitude arrays (`amplifyValuesByLevel` etc.) are prefab-serialized and **unknown from the DLL** (§7 G3). Expose `levelExponent` so `f(L) = L^γ` can be tuned once those are dumped.

### 4.3 Mode (b) — even

Goal: spread enhancement instead of stacking it. Use a **concave utility** — it produces the right behaviour with a smooth landscape (no variance term, no non-local coupling, still delta-evaluable):

```
u(L) = Σ_{k=1..L} 1/k          // discrete harmonic; precompute u[0..maxPossibleLevel]

Score_even =
      W_LEVEL * Σ_c  enabled(c) · rel(c) · u(min(level[i_c], maxLevel_c))
    + W_ON    * Σ_c  enabled(c) · rel(c)
    - W_OFF   * Σ_c (1 − enabled(c)) · rel(c)
    + W_TIER  * Σ_{cat ∈ P} w(cat) · tiers(cat)
    - W_NEG   * Σ_c  max(0, −level[i_c])
    + W_MIN   * min over enabled c of min(level[i_c], maxLevel_c)
```

`u` is strictly concave, so moving a level from a charm at 4 to a charm at 0 is a strict gain (`u(1)−u(0)=1.0` vs `u(4)−u(3)=0.25`), which is exactly "even". `W_MIN` (default `3000`) adds an explicit max-min pressure; set it to 0 for pure concave behaviour.

If the user wants strict statistical evenness instead, offer the variance form as an alternative term (`− W_VAR · Σ (capped_c − mean)²`, `W_VAR ≈ 2000`) — but the concave form is the default because variance is non-separable and kills delta evaluation.

Both modes share the enabled/disabled/negative/tier terms so the two scores are on the same scale and `improvement` is meaningful **within a mode**. Never compare across modes, and never compare against `EvaluateCurrentAutoArrangeScore`.

---

## 5. Search algorithm

### 5.1 Search space

`|space| = P(Storage, nItems) · Π_{rotatable tablets} 4`. At `Storage=30, nItems=20, 5 rotatable tablets` that is ~10²³. No brute force in general.

### 5.2 Two-tier solver — take the exact path when it is available

The problem **decomposes** when two conditions hold, and both are checkable at snapshot time:

- **C1 — no tablet condition depends on charm placement.** True when every tablet's `p.Criteria.Length == 0` for all `(rot, origin)` (i.e. `conditionQuery` produces no `AnyItem`/`OnlyCharm` lines). `PLACED`-only conditions still qualify, since `PlacedSatisfied` is layout-independent.
- **C2 — no charm criterion interacts with other charms.** True when no charm has `BothSideCharm`, `BothSidesAreEmpty`, `NeighborsAreFull` or `Near8MagicBook`.

Under **C1**, the entire `level/disable/ignore/mul` field is a function of the tablet sub-arrangement **alone**. Under **C1 ∧ C2**, for a fixed field, each charm's contribution depends only on its own cell → assigning charms to cells is an exact **linear assignment problem**.

```
TIER-1 (exact, preferred):
  requires C1 ∧ C2 ∧ (nTabletConfigs <= EXACT_BUDGET, default 400_000)
  nTabletConfigs = C(Storage, nTablets) · Π 4^rotatable      [minus StaticallyDead prunes]
  for each tablet config:
      build the level field once                  O(Storage + Σ pattern sizes)
      cost[charm][cell] = −(that charm's objective contribution at that cell)
      solve Hungarian / JV                        O(n³), n = nCharms + padding
      keep the best
  → provably optimal.
```

With 3 tablets on 30 slots and all rotatable: `C(30,3)·3!·4³ = 4060·6·64 ≈ 1.56M` — over budget; with 3 tablets where 2 are rotatable it is ~390k — in budget. Enumerate *positions* as combinations and let the Hungarian pass handle tablet-identity permutation only when tablets differ; identical tablets can be deduplicated by `(EntityID, query)` for a large constant-factor win.

Note the objective terms that are **not** separable per charm: `tiers(cat)` (depends on the whole charm set, but under `CategoryRule.Static` for all charms it is a layout-**invariant** constant and drops out) and `W_MIN` in even mode (drop `W_MIN` to 0 in tier-1, or run tier-1 as a lower bound and refine with tier-2). Document this: tier-1 is exact for combo-max with all-`Static` charms; for the other cases it is a very strong initializer.

```
TIER-2 (fallback): simulated annealing / iterated local search seeded by tier-1's answer,
                   or by the current layout when tier-1 is unavailable.
```

### 5.3 Changes to the annealer

1. **Slot-based, not item-based.** Operate on `Layout.SlotToItem[0..Storage)` including empties, so items can migrate into holes. The current `PerformPairOrChainSwap` can never do this.
2. **Rotation operator:** pick a tablet with `Rotatable == true`, set `Rotation = (r + 1 + rand(3)) % 4` (guaranteed change). Reject at snapshot time, not in the loop, if no rotatable tablets exist.
3. **Operator mix** (tune, these are sane defaults): 30 % rotate, 40 % swap two slots, 15 % 3-cycle, 15 % *targeted* — move a tablet to a slot whose pattern covers the currently-highest-`rel` under-levelled charm. The targeted operator is what actually finds tablet placements; blind swapping on a 30-slot grid with 3 tablets is nearly random.
4. **Budget by wall clock, not iterations.** One full evaluation is `O(Storage + Σ pattern sizes + nCharms)` ≈ a few hundred int ops. `maxIterations = 3500` is roughly 2 ms of work. Budget 1–3 seconds → 10⁵–10⁶ evaluations. Expose `timeBudgetMs`.
5. **Delta evaluation:** a swap of two slots invalidates only tablets whose pattern touches either slot, plus tablets that *moved*. Maintain a reverse index `slot → tablets whose Effects/Criteria touch it`. Fall back to full recompute when a tablet moves or rotates (cheap enough).
6. **Restarts:** `k` independent runs (default 4) with different seeds, keep the best. Deterministic seed derived from the snapshot hash so results are reproducible and diffable.
7. **Acceptance:** keep Metropolis but fix the temperature scale — with `W_LEVEL = 10000` a `temp = 150` start means essentially hill-climbing from iteration 1. Set `T₀ = 0.05 · |initialScore|` (or the observed mean |Δ| over 200 random probes) and `T_end = T₀ / 1000`, geometric.
8. **Feasibility is free** — every permutation of items over `[0, Storage)` is legal (single-cell items, no type restriction). The only hard constraints are `Movable == false` items (excluded from the permutation) and pinned rotations. No repair step needed.

### 5.4 Do NOT

- Call `GridInventory.AutoArrangeInventoryForBestCharmLevels` or `ApplyAutoArrangeStateAndEvaluate` as an oracle. Each candidate evaluation **physically mutates the live inventory**: `ApplyAutoArrangeState` wipes and rewrites `inventoryMatrix` / `charms` / `stoneTablets` and rewrites `charm.NetworkxIdx/yIdx` and `tablet.Networkrotation` (`GridInventory.cs:4802-4830`), inside a `Permission` scope that tears down and rebuilds every tablet/charm/set-effect and fires `RpcReleasePermission` (`GridInventory.cs:2712`). ~1100 full teardown cycles plus RPC traffic per run.
- Call `EvaluateCurrentAutoArrangeScore` per candidate — it reads only live state and is `[Server]`-gated.

---

## 6. Runtime integration

### 6.1 Threading contract

```
[Unity main thread]  Snapshot()        — touches GridInventory, Charm_Basic, StoneTablet,
                                          ItemDatabase, DungeonManager, ComboEffectBase, ParseQuery
[ThreadPool]         Search()          — touches only int[]/byte[]/struct arrays
[Unity main thread]  Apply() / Report()
```

Everything that touches a `SyncDictionary`, a `UnityEngine.Object` implicit-bool (`(bool)value7` in `GridInventory.cs:2585` is a native call), `ItemDatabase.FindItemById` (via `NewItemOwnInstance.Entity`), or `Debug.Log*` **must** be on the main thread.

`StoneTablet.ParseQuery` is itself pure and thread-safe (verified: its entire member-access set is `CultureInfo`, `int.Parse`, `Split`, `List.Add`, `originPos.x/y`, `GridInventory.IdxToPos/PosToIdx`), **but** `new AdditionEffectData(md)` calls `Debug.LogError` on a malformed value (`StoneTablet.cs:154`, `:159`). Run both on the main thread during snapshot (§1.3) and hand the search only `EffCell[]`/`CritCell[]`.

Guard the snapshot: `if (!NetworkServer.active) { /* levelMatrix may be a client mirror; still readable, but mark result advisory */ }`.

### 6.2 Progress + result plumbing

```csharp
internal sealed class OptimizerJob {
    public volatile int   ProgressPermille;   // Interlocked-written by the worker
    public volatile bool  Done;
    public volatile bool  Faulted;
    public string         Error;              // set before Done
    public OptimizeData   Result;             // plain POCO, Models.cs
}
```

Poll from the existing plugin `MonoBehaviour.Update()` (`Plugin.cs`) and push a `optimize_progress` frame over `SimpleWebSocketServer` at ≤ 10 Hz. Never marshal by calling back into Unity from the worker. Cancellation: a `volatile bool Cancel` checked every 1024 iterations.

### 6.3 Result shape

Extend `Models.cs`:

```csharp
[Serializable] public class ItemMove {
    public int instanceID; public int newX; public int newY;
    public int newRotation;      // NEW: 0..3, -1 = unchanged / not a tablet
}
[Serializable] public class OptimizeData {
    public float optimizedScore;
    public float baselineScore;  // NEW: same objective, current layout
    public float improvement;    // optimizedScore - baselineScore, same units
    public string mode;          // "combo-max" | "even"
    public bool  exact;          // NEW: true when tier-1 solved it
    public List<ItemMove> suggestedLayout;
    public List<string> warnings;// NEW: fidelity gaps hit (§7)
}
```

### 6.4 Apply

Must be main thread and server (`inventory.isServer` / `NetworkServer.active`).

**Moves** — decompose the target permutation into cycles, emit each cycle as `len-1` transpositions, and issue each via the public `GridInventory.Swap(sbyte xLeft, sbyte yLeft, sbyte xRight, sbyte yRight)` (`GridInventory.cs:2262`, routes to `LocalSwap` on server / `CmdSwap` on client). `LocalSwap` opens its own `Permission` scope (`GridInventory.cs:2294`) so each swap is a complete, consistent teardown/rebuild. Do not batch-write `inventoryMatrix` yourself — `Permission` is private and `GetPermission` hard-errors if re-entered while `writePermission` is already true (`GridInventory.cs:2477-2481`).

**Rotations** — `StoneTablet.Rotate()` (`StoneTablet.cs:2411`), called `k = (target − current + 4) % 4` times. It self-gates on `DungeonManager.IsTabletRotatable`, so an illegal request is a silent no-op (good). **`Rotate()` does not open a `Permission` scope** — it only sets `Networkrotation` and fires `RpcSendMessageTabletRotated` (`GridInventory.cs:4567-4570`), which is a pure client notification. So after all rotations you must force one recompute.

**Forcing a recompute:** issue a self-swap `inventory.Swap(x, y, x, y)` on any occupied non-potion cell. Reading `LocalSwap` (`GridInventory.cs:2287-2376`) line by line with `left == right`: `valueOrDefault == valueOrDefault2`, both non-null branches re-write the *identical* `NewItemOwnInstance` / `Charm_Basic` / `StoneTablet` with the *same* indices, and the `Remove` branches only fire when that dictionary has no entry for the cell — symmetric, so nothing is lost. It is idempotent, and it opens/closes one `Permission` scope, which is exactly the full rebuild. **Mark this as needing a smoke test before shipping** (§7 G8) — it is a read-derived conclusion, not an observed one.

Ordering: apply all moves first (each already refreshes), then all rotations, then one self-swap. Do it in a single frame; ~20 swaps × one rebuild each is well under a frame budget.

### 6.5 Validation harness (build this first)

Immediately after `Snapshot()`, run the §3 evaluator on the **current** layout and diff:

| Virtual | Live | Tolerance |
|---|---|---|
| `level[i]` | `inventory.levelMatrix[IdxToPos(i)]` (default 0) | exact |
| `disable[i]` | `inventory.disableMatrix[...]` | exact |
| `ignore[i]` | `inventory.ignoreCriteriaMatrix[...]` | exact |
| `enabled(c)` | `charm.IsEffectEnabled` | exact |
| `min(max,level)` | `charm.limitedEffectEnabledLevel` | exact |
| per-tablet effect set | `tablet.EffectRange` (`SyncList<AdditionEffectData>`, live ground truth) | set-equal |
| per-tablet active | `tablet.IsApplied` (SyncVar) | exact |
| combo counts | `inventory.currentSetEffectCount` | exact |

`StoneTablet.Criterias` (`SyncList<CriteriaHistory> { hit, hitPlaced, criteria }`) is a per-criterion pass/fail audit trail populated even when the tablet ends up inactive — use it to localise a mismatch to a specific criterion line. Log every mismatch with cell index and item name, and gate `Apply` behind a clean diff (or a user override). Without this harness the rewrite is unverifiable.

---

## 7. Gaps — ordered by blast radius, with the cheapest resolution

| # | Gap | Why it matters | Cheapest resolution |
|---|---|---|---|
| **G1** | **Actual tablet query strings are unknown statically.** They live in Unity prefabs (`[TextArea] conditionQuery` / `query`, `StoneTablet.cs:196-200`) or, for `isCustomTablet`, in `DungeonManager` keyed by `instanceID`. | Everything in §1.3/§3 depends on them. | Always read via `tablet.GetQuery(tablet.instanceID)` / `GetConditionQuery(tablet.instanceID)` (`StoneTablet.cs:326-341`) — never the raw fields. **Log every distinct `(entityID, query, conditionQuery)` pair once per run** to a file; that also answers which of the 47 keywords are live. |
| **G2** | Fidelity of the `ParseQuery`-with-hypothetical-origin approach is unproven end-to-end. | If wrong, every score is wrong. | §6.5 harness: assert `ParseQuery(query, …, currentOrigin, currentRot)` reproduces the live `tablet.EffectRange` exactly, for every tablet, on every snapshot. Free, continuous. |
| **G3** | **Per-level effect magnitude arrays are unknown** (`amplifyValuesByLevel`, `damagePercentByLevel`, … are prefab-serialized). Only the indexing (clamp to `[0, maxLevel]`) is verified. | The objective's `f(L) = L` is a proxy; a charm whose curve is flat above level 2 is over-valued. | Reflect over the live `Charm_Basic` subclass instance for `public` array fields whose length is `maxLevel+1`, dump them once, and derive per-charm marginal utility. Until then keep `levelExponent` configurable and say so in the UI. |
| **G4** | **Combo threshold tables are not in the DLL** and the shipped values differ from the source defaults (`ComboEffect_Alchemy`: `first=3`, `activeSecond=false` shipped vs `2`/`true` in code). | `W_TIER` term is garbage if hardcoded. | Read live: `ItemDatabase.GetAllItemCategory()` → `comboEffectPrefab.GetComponent<ComboEffectBase>()` → `BuildEffectData(avatar).Keys`. Cache once per run. Dump to log for the dashboard. |
| **G5** | `Charm_WhitePaper.SearchCategory` exact semantics only partially confirmed; `match`, `lineCategory`, `xOffset/yOffset` are serialized fields whose shipped values may differ from the C# initializers. | Wrong combo delta for those charms. | Snapshot the live field values (`match`, `lineCategory`, `xOffset`, `yOffset`) instead of hardcoding, and validate resolved categories against the live `charm.GetItemCategory()` at the current position. |
| **G6** | **Item → categories map** is not currently exported. `DataCollector.cs:302` writes `entity.type` (an `EItemType`) into the `category` field — that is a **bug**; it is not a combo category. | Combo mode cannot work. | Fix `DataCollector` to emit `ItemEntity.categories` (`List<string>`) as `categories[]` and keep `type` separate. |
| **G7** | `disableMatrix` key-persistence path dependency (§3.4). | Only bites when `globalActiveValue <= 0`. | Seed `EverHadDisableKey` from live keys; emit a `warnings[]` entry when `globalActiveValue <= 0`. |
| **G8** | Self-swap as a recompute trigger is read-derived, not observed. Also unverified: whether any UI path already refreshes after `Rotate()`. | Applied rotations could leave a stale `levelMatrix`. | One manual smoke test: rotate a tablet via the plugin, self-swap, compare `levelMatrix` to a re-snapshot. If it fails, fall back to `inventory.Swap(a,b); inventory.Swap(a,b)` (two real swaps, net identity). |
| **G9** | Whether the client UI forbids dropping items on some in-storage cells. The server only checks occupancy. | The optimizer could propose a layout the player cannot hand-build. | Apply programmatically via `Swap` (server path) — sidesteps the UI entirely. Flag any proposed cell that the current layout never occupies. |
| **G10** | `uniquePairArtifactConvertDataServerside` can add >1 to a combo count and has a `maxLevel` term (`GridInventory.cs:3344-3443`, gated by `KeywordDatabase.GetConstValue("allowUniquePairIncreaseCombo")`). Whether it is position-dependent is unverified. | Combo counts off by a few when enchanted unique pairs are present. | Compute the delta once as `live currentSetEffectCount[cat] − (our static count)` and carry it as a constant `UniquePairExtra[cat]`. Self-correcting and requires no new mechanics. |
| **G11** | `CharmActivateCriteria_SideEnd` hardcodes `x == 5` (`GetCriteria`) while its UI twin tests `pos.y == 5` — an upstream bug. If patched, the UI changes, not gameplay. | Low. | Use `GetCriteria`'s form (`x == 0 || x == 5`). Assert `Width == 6` and warn otherwise. |
| **G12** | Whether the plugin runs where `NetworkServer.active` is true. | `[Server]` methods no-op silently; `Swap` would route to `CmdSwap`. | Log `NetworkServer.active`, `inventory.isServer`, `inventory.isClient` once at snapshot. Refuse to `Apply` if neither server nor an owned client connection. |
| **G13** | `SearchSetEffectInInventory` / `DisableCurrentSetEffect` were shown not to write `levelMatrix` directly, but not every `Charm_*` subclass was audited for an indirect write. | An unmodelled level source. | The §6.5 `level[i]` diff catches it empirically. If a mismatch appears on a specific charm, audit that subclass. |
| **G14** | `ArrangementBonus` is dead — `GridInventory.ArrangementBonusEnabled()` returns hardcoded `false` (`GridInventory.cs:431-434`), gating `SearchArrangementBonusInInventory` at `:2687`. | `Models.ArrangementBonusInfo` and its collector are dead weight. | Delete or mark deprecated; do not model it in the objective. |

---

## 8. File layout for the rewrite

```
SephiriaPlugin/
  Optimizer/
    Snapshot.cs            §1  — main-thread capture, TabletPattern build, validation diff
    VirtualEvaluator.cs    §3  — level/disable/ignore/mul + activation, zero allocation
    Criteria.cs            §2.4 — the 10 predicates, pure, int-indexed
    Categories.cs          §4.1 — Static / RowElemental / WhitePaper / UpCharmChain, Pre→Default→Post
    Objective.cs           §4.2/§4.3 — combo-max and even
    ExactSolver.cs         §5.2 — tablet enumeration + Hungarian
    Annealer.cs            §5.3 — slot-based SA with legal rotations
    OptimizerJob.cs        §6.2 — threading, progress, cancellation
    Applier.cs             §6.4 — cycle decomposition, Swap, Rotate, forced refresh
  CustomArrangementOptimizer.cs   — thin façade preserving the existing entry point
```

**Build order:** `Snapshot` + `VirtualEvaluator` + the §6.5 validation diff **first**, and do not write a single line of search code until the diff is clean against the live game on at least three different real inventories. Every previous defect in this file came from optimizing a fitness nobody had validated.