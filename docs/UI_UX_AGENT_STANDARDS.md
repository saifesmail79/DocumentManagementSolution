# UI/UX Agent Standards Guide

> **Purpose**: This guide gives an AI coding agent every detail needed to produce a UI that exactly matches the reference application.  
> **Layout Direction**: RTL (Right-to-Left) — all examples are written for RTL layout.  
> **Stack**: React + Tailwind CSS + Lucide React Icons  
> **Reference files**: `SalesCustomersPage.jsx` / `PurchaseOrdersPage.jsx` / `SalesTransactionsPage.jsx` / `InventoryDashboardPage.jsx` / `TileMenu.jsx` / `TRANSACTION_ENTRY_UI_STANDARDS.md`

---

## Table of Contents

1. [Color System & Theme](#1-color-system--theme)
2. [Shell Layout Structure](#2-shell-layout-structure)
3. [Tile Menu (Module Navigation)](#3-tile-menu-module-navigation)
4. [Top Header Bar](#4-top-header-bar)
5. [Page Header](#5-page-header)
6. [List Toolbar](#6-list-toolbar)
7. [Data Grid (List View)](#7-data-grid-list-view)
8. [Row Action Menu (ExpandableActions)](#8-row-action-menu-expandableactions)
9. [Standard Action Buttons](#9-standard-action-buttons)
10. [Forms & Modals](#10-forms--modals)
11. [Input Fields](#11-input-fields)
12. [SearchableSelect Dropdown](#12-searchableselect-dropdown)
13. [Search Bar](#13-search-bar)
14. [Tabs](#14-tabs)
15. [Line Items Data Entry Grid](#15-line-items-data-entry-grid)
16. [Totals Section](#16-totals-section)
17. [Status Badges](#17-status-badges)
18. [Dashboard KPI Cards](#18-dashboard-kpi-cards)
19. [Section Headers & Info Cards](#19-section-headers--info-cards)
20. [Pagination](#20-pagination)
21. [Toast Notifications](#21-toast-notifications)
22. [Confirm Dialogs](#22-confirm-dialogs)
23. [Keyboard Shortcuts Panel](#23-keyboard-shortcuts-panel)
24. [Loading States](#24-loading-states)
25. [Empty States](#25-empty-states)
26. [Validation Rules](#26-validation-rules)
27. [Focus & Keyboard Navigation Rules](#27-focus--keyboard-navigation-rules)
28. [Transaction Form Lifecycle](#28-transaction-form-lifecycle)
29. [Implementation Checklist](#29-implementation-checklist)

---

## 1. Color System & Theme

### CSS Custom Properties (Design Tokens)

All application colors are defined as CSS custom properties. **Hardcoded colors are strictly forbidden.**

```css
:root {
  --color-primary:            28 100 242;   /* Primary blue */
  --color-primary-dark:       26 86 219;    /* Darker blue (hover state) */
  --color-accent:             249 115 22;   /* Orange accent */
  --color-surface:            255 255 255;  /* Card / modal background */
  --color-surface-muted:      241 245 249;  /* Page background / muted areas */
  --color-control:            255 255 255;  /* Input field background */
  --color-text:               15 23 42;     /* Primary text */
  --color-text-muted:         100 116 139;  /* Secondary / placeholder text */
  --color-border:             203 213 225;  /* All borders */
  --color-border-strong:      148 163 184;  /* Stronger border on hover */
  --color-sidebar:            15 23 42;     /* Sidebar background */
  --color-sidebar-foreground: 226 232 240;
  --color-sidebar-muted:      148 163 184;
  --color-on-primary:         255 255 255;  /* Text rendered on primary color */
  --color-success:            16 185 129;   /* Green */
  --color-warning:            245 158 11;   /* Amber / yellow */
  --color-danger:             239 68 68;    /* Red */
}
```

### Tailwind Class Usage Reference

| Usage | Class | Notes |
|-------|-------|-------|
| Page background | `bg-surface-muted` | Outer background behind cards |
| Card / table background | `bg-surface` | Cards, modals, tables |
| Muted area background | `bg-surface-muted` | Table headers, tabs |
| Primary text | `text-text` | Headings and body |
| Secondary text | `text-text-muted` | Labels, placeholders |
| Primary accent | `text-primary` / `bg-primary` | Icons, buttons, focus |
| Primary dark (hover) | `bg-primary-dark` | Button hover state |
| Borders | `border-border` | All borders |
| Row dividers | `divide-border/50` | Inside tables |
| Row hover | `hover:bg-surface-muted/30` | Table rows |
| Light primary background | `bg-primary/10` | Icon containers, badges |
| Focus ring | `focus:ring-primary` | Input fields |

### Allowed Semantic Colors (Exceptions to the No-Hardcode Rule)

| Purpose | Allowed Tailwind Classes |
|---------|--------------------------|
| Error / Delete | `text-red-500`, `text-red-600`, `bg-red-50`, `border-red-200` |
| Success | `text-green-600`, `bg-green-50`, `border-green-200` |
| Warning | `text-amber-600`, `bg-amber-50`, `border-amber-200` |
| Info | `text-blue-600`, `bg-blue-50` |
| Delete button | `text-red-400 hover:text-red-600 hover:bg-red-50` |

---

## 2. Shell Layout Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  HEADER BAR  (border-b border-border bg-surface shadow-sm)                  │
│  [Back]  [Logo] [App Name]       [Global Search]       [User] [Lang] [Out]  │
├─────────────────────────────────────────────────────────────────────────────┤
│  BREADCRUMB  (border-b border-border bg-surface px-6 py-2 text-sm)          │
│  Sales > Customers                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│  CONTENT AREA  (flex-1 overflow-auto p-6 bg-surface-muted)                  │
│    PAGE HEADER                                                               │
│    TOOLBAR (search + action buttons)                                         │
│    DATA GRID / FORM                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Root Structure

```jsx
<div className="flex min-h-screen bg-surface-muted text-text">
  <div className="flex flex-1 flex-col">
    <header className="border-b border-border bg-surface shadow-sm">
      {/* Header Bar */}
    </header>
    <div className="border-b border-border bg-surface px-6 py-2 text-sm text-text-muted">
      {/* Breadcrumb: Module > Page */}
    </div>
    <main className="flex-1 overflow-auto p-6">
      {/* Page Content */}
    </main>
  </div>
</div>
```

---

## 3. Tile Menu (Module Navigation)

The home page displays a grid of module tiles. Clicking a tile expands a panel below it showing sub-items.

### Module Tile (ModuleTile)

```jsx
<button className={`
  group relative flex flex-col items-center justify-center
  p-4 sm:p-6 transition-all duration-300
  hover:scale-105
  focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 rounded-lg
  min-h-[120px] sm:min-h-[140px]
  ${isActive
    ? 'bg-primary/10 border-2 border-primary/30 shadow-md'
    : 'hover:bg-surface-muted/50'
  }
`}>
  {/* Expand indicator when active */}
  {isActive && (
    <div className="absolute top-1 rtl:left-1 ltr:right-1">
      <ChevronUp className="w-4 h-4 text-primary animate-pulse" />
    </div>
  )}
  {/* Module icon */}
  <div className={`
    p-4 rounded-lg shadow-lg group-hover:shadow-xl transition-all mb-3
    ${isActive ? 'bg-primary ring-2 ring-primary/50 ring-offset-2' : 'bg-primary'}
  `}>
    <Icon className="w-8 h-8 sm:w-10 sm:h-10 text-on-primary" />
  </div>
  {/* Module name */}
  <span className="text-sm sm:text-base font-semibold text-text text-center">
    {moduleName}
  </span>
</button>
```

### Tile Grid Layout

```jsx
<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6">
  {modules.map(module => <ModuleTile key={module.key} {...module} />)}
</div>
```

### Expanded Module Content

Rendered below the tile grid when a tile is active. Animates in from top.

```jsx
<div className="mt-6 p-6 rounded-lg border-2 border-primary/20 bg-primary/5 animate-in slide-in-from-top-4 duration-300">
  {/* Header */}
  <div className="flex items-center justify-between mb-6">
    <div className="flex items-center gap-3">
      <div className="p-2 rounded-lg bg-primary">
        <Icon className="w-5 h-5 text-on-primary" />
      </div>
      <h3 className="text-lg font-semibold text-text">{moduleName}</h3>
    </div>
    <button className="p-2 rounded-lg hover:bg-surface-muted transition-colors">
      <X className="w-5 h-5 text-text-muted" />
    </button>
  </div>

  {/* Subgroup heading: horizontal rule + label */}
  <div className="flex items-center gap-2 mb-4">
    <span className="text-sm font-semibold text-text-muted uppercase tracking-wide">
      {subgroupName}
    </span>
    <div className="flex-1 h-px bg-border" />
  </div>

  {/* Sub-item grid */}
  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
    {items.map(item => <SubItemTile key={item.key} {...item} />)}
  </div>
</div>
```

### Sub-Item Tile

```jsx
<div className="group relative flex items-center">
  <button className="
    flex-1 flex items-center gap-3
    px-4 py-3 rounded-sm border transition-all duration-200
    bg-surface border-border hover:border-primary/50
    hover:shadow-md rtl:hover:-translate-x-1 ltr:hover:translate-x-1
    focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1
  ">
    <div className="p-2 rounded-sm bg-primary shadow transition-shadow group-hover:shadow-md">
      <Icon className="w-4 h-4 text-on-primary" />
    </div>
    <span className="text-sm font-medium text-text">{itemName}</span>
  </button>
  {/* Open-in-new-tab button — visible on hover */}
  <button className="absolute rtl:left-2 ltr:right-2 opacity-0 group-hover:opacity-100 p-1.5 rounded bg-surface-muted hover:bg-primary/10 text-text-muted hover:text-primary border border-border transition-all">
    <ExternalLink className="w-3 h-3" />
  </button>
</div>
```

### Suggested Module Icons (Lucide React)

| Module | Icon |
|--------|------|
| Dashboard | `LayoutDashboard` |
| Inventory | `Package` |
| Sales | `FileBarChart` |
| Purchasing | `Truck` |
| General Ledger | `BookOpen` |
| HR | `Users` |
| Settings | `Settings` |
| Security | `Shield` |
| Fixed Assets | `Building2` |
| Notifications | `Bell` |
| Customers | `Users` |
| Suppliers | `Building2` |
| Purchase Orders | `ClipboardList` |
| Receiving | `PackageCheck` |
| Pricing | `DollarSign` |

---

## 4. Top Header Bar

```jsx
<header className="border-b border-border bg-surface shadow-sm">
  <div className="flex items-center justify-between px-6 py-3">

    {/* RIGHT SIDE in RTL: Back button + Logo + App name */}
    <div className="flex items-center gap-3">
      {!isHomePage && (
        <button className="p-2 rounded-lg hover:bg-surface-muted text-text-muted hover:text-text transition-colors">
          <ArrowRight size={20} />  {/* RTL: ArrowRight = go back */}
        </button>
      )}
      <img src={logoUrl} className="h-8 w-auto object-contain cursor-pointer" />
      <span className="text-lg font-semibold text-text cursor-pointer hover:text-primary transition-colors">
        {appName}
      </span>
    </div>

    {/* CENTER: Global search */}
    <div className="hidden md:block flex-1 mx-8 max-w-xl">
      {/* GlobalMenuSearch component */}
    </div>

    {/* LEFT SIDE in RTL: User info + Language toggle + Logout */}
    <div className="flex items-center gap-4">
      <div className="hidden text-right text-xs text-text-muted sm:block">
        <div className="font-medium text-text">{firstName} {lastName}</div>
        <div className="text-xs text-text-muted">{username} · {email}</div>
      </div>
      <button className="p-2 rounded-lg hover:bg-surface-muted text-text-muted hover:text-text">
        <Languages size={18} />
      </button>
      <button className="p-2 rounded-lg hover:bg-surface-muted text-text-muted hover:text-text">
        <LogOut size={18} />
      </button>
    </div>
  </div>
</header>
```

### Breadcrumb Bar

```jsx
<div className="border-b border-border bg-surface px-6 py-2 text-sm text-text-muted">
  {parentModule} &gt; {currentPage}
</div>
```

Example display: `Sales > Customers` or `Purchasing > Purchase Orders`

---

## 5. Page Header

```jsx
<div className="flex items-center gap-3 mb-6">
  {/* Icon container */}
  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
    <UsersIcon size={22} className="text-primary" />
  </div>
  {/* Title + subtitle */}
  <div>
    <h1 className="text-xl font-bold text-text">{pageTitle}</h1>
    <p className="text-sm text-text-muted">{pageSubtitle}</p>
  </div>
</div>
```

**Rules:**
- Icon container: `w-10 h-10 rounded-lg bg-primary/10`, icon color: `text-primary`
- Title: `text-xl font-bold text-text`
- Subtitle: `text-sm text-text-muted`

---

## 6. List Toolbar

```jsx
<div className="flex items-center justify-between gap-4 mb-4">

  {/* RIGHT SIDE (RTL): search input + additional filters */}
  <div className="flex items-center gap-3 flex-1">
    <DebouncedSearchInput
      value={search}
      onChange={setSearch}
      placeholder="Search..."
      className="max-w-xs"
    />
    {/* Optional additional filter (SearchableSelect) */}
    <SearchableSelect ... />
  </div>

  {/* LEFT SIDE (RTL): action buttons — flex-row renders Create → Export → Import left-to-right */}
  <div className="flex items-center gap-2 flex-row">
    {canCreate && <CreateButton onClick={handleCreate} />}
    {canExport && <ExportButton onClick={handleExport} />}
    {canImport && <ImportButton onClick={() => setImportModalOpen(true)} />}
  </div>
</div>
```

> **RTL button order rule**: `flex-row` renders buttons left-to-right on screen: Create → Export → Import.

---

## 7. Data Grid (List View)

### Full Structure

```jsx
<div className="bg-surface rounded-xl border border-border overflow-hidden">
  <table className="w-full text-sm">
    <thead>
      <tr className="bg-surface-muted text-text-muted text-xs uppercase tracking-wider">
        <th className="px-4 py-3 text-right font-semibold border-b border-border">Code</th>
        <th className="px-4 py-3 text-right font-semibold border-b border-border">Name</th>
        <th className="px-4 py-3 text-center font-semibold border-b border-border">Actions</th>
      </tr>
    </thead>
    <tbody className="divide-y divide-border">
      {items.map((item, index) => (
        <tr key={item.id} className="hover:bg-surface-muted/50 transition-colors">
          <td className="px-4 py-3 text-right text-text">{item.code}</td>
          <td className="px-4 py-3 text-right text-text font-medium">{item.name}</td>
          <td className="px-4 py-3">
            <div className="flex items-center justify-center">
              <ExpandableActions ... />
            </div>
          </td>
        </tr>
      ))}
    </tbody>
  </table>

  {/* Footer: pagination */}
  <div className="px-4 py-3 border-t border-border bg-surface-muted/50">
    {/* Pagination */}
  </div>
</div>
```

### Column Alignment Rules

| Data Type | Alignment | Class |
|-----------|-----------|-------|
| Text | Right (RTL default) | `text-right` |
| Numbers / Amounts | Left (override RTL) | `text-left` |
| Status badges | Center | `text-center` |
| Action column | Center | `text-center` |
| Row number | Center | `text-center` |

### Data Row Pattern

```jsx
<tr className="hover:bg-surface-muted/50 transition-colors group">
  {/* Row number */}
  <td className="px-4 py-3 text-center text-text-muted text-xs">{index + 1}</td>

  {/* Clickable name — opens detail view */}
  <td className="px-4 py-3">
    <button
      onClick={() => handleOpenView(item)}
      className="text-primary hover:text-primary-dark hover:underline font-medium text-right w-full block"
    >
      {item.name}
    </button>
  </td>

  {/* Amount — always left-aligned */}
  <td className="px-4 py-3 text-left font-mono text-text">{formatAmount(item.amount)}</td>

  {/* Status badge */}
  <td className="px-4 py-3 text-center">
    <StatusBadge status={item.status} />
  </td>

  {/* Actions */}
  <td className="px-4 py-3">
    <div className="flex items-center justify-center">
      <ExpandableActions onView={...} onEdit={...} onDelete={...} isActive={item.isActive} />
    </div>
  </td>
</tr>
```

---

## 8. Row Action Menu (ExpandableActions)

Every data grid row **MUST** use the `ExpandableActions` component. Never render raw icon buttons directly in action cells.

```jsx
import ExpandableActions from '@/components/ExpandableActions.jsx';

<ExpandableActions
  onView={() => handleOpenView(row)}
  onEdit={canUpdate ? () => handleOpenEdit(row) : undefined}
  onToggleActive={canUpdate ? () => handleToggleActive(row) : undefined}
  onDelete={canDelete ? () => handleDelete(row) : undefined}
  isActive={row.isActive !== false}
  canDelete={!row.hasReferences}
/>
```

### Built-in Action Colors

| Action | Icon | Background | Text Color |
|--------|------|-----------|------------|
| View | `Eye` | `bg-primary/10` | `text-primary` |
| Edit | `Edit` | `bg-emerald-500/10` | `text-emerald-600` |
| Activate | `Power` | `bg-green-500/10` | `text-green-600` |
| Deactivate | `Power` | `bg-amber-500/10` | `text-amber-600` |
| Delete | `Trash2` | `bg-red-500/10` | `text-red-600` |

### Custom Domain-Specific Actions

```jsx
<ExpandableActions
  customActions={[
    {
      key: 'print',
      icon: Printer,
      onClick: () => handlePrint(row),
      show: canPrint,
      title: 'Print',
      bgClass: 'bg-indigo-500/10',
      textClass: 'text-indigo-600',
      hoverClass: 'hover:bg-indigo-500/20',
    },
    {
      key: 'post',
      icon: CheckCircle,
      onClick: () => handlePost(row),
      show: row.status === 'draft',
      title: 'Post',
      bgClass: 'bg-green-500/10',
      textClass: 'text-green-600',
      hoverClass: 'hover:bg-green-500/20',
    },
  ]}
/>
```

### Behavior

- Renders as a single `MoreHorizontal` ellipsis icon at rest.
- On hover: expands horizontally to reveal action buttons (speed-dial pattern).
- During async action: shows `<Loader2 className="animate-spin" />` on active button; all other row buttons are disabled.
- RTL-aware: button row direction reverses automatically.

### Anti-Patterns (Forbidden)

```jsx
// ❌ WRONG — single delete icon only
<button onClick={() => handleDelete(row.id)} className="text-red-600">
  <Trash2 className="w-4 h-4" />
</button>

// ❌ WRONG — three separate inline icon buttons
<div className="flex gap-2">
  <button><Eye /></button>
  <button><Edit /></button>
  <button><Trash2 /></button>
</div>

// ✅ CORRECT
<ExpandableActions onView={...} onEdit={...} onToggleActive={...} onDelete={...} isActive={row.isActive} />
```

---

## 9. Standard Action Buttons

Use the canonical components from `src/components/IconButtons.jsx`. Never create custom `<button>` elements with hardcoded color classes for these standard actions.

```jsx
import { CreateButton, ExportButton, ImportButton } from '@/components/IconButtons.jsx';
```

### Components Reference

| Component | Icon | Style | Purpose |
|-----------|------|-------|---------|
| `<CreateButton />` | `Plus` | `bg-success/10 text-success` | Create new record |
| `<ExportButton />` | `Download` | `bg-primary/10 text-primary` | Export to Excel |
| `<ImportButton />` | `Upload` | `bg-warning/10 text-warning` | Import from Excel |

### Icon Button Style Pattern

```jsx
// Shape: rounded-full
// Hover: hover:scale-105
// Sizes: xs=h-7 w-7 | sm=h-8 w-8 | md=h-9 w-9 | lg=h-10 w-10
<button className="inline-flex items-center justify-center rounded-full transition duration-200
  h-8 w-8 bg-success/10 text-success hover:bg-success/20 hover:scale-105
  disabled:opacity-50 disabled:cursor-not-allowed">
  <Plus size={18} strokeWidth={2.5} />
</button>
```

### Anti-Pattern (Forbidden)

```jsx
// ❌ WRONG — custom button with hardcoded colors
<button className="inline-flex items-center gap-2 px-3 py-2 bg-primary text-white rounded-lg">
  <Plus /> Create
</button>

// ✅ CORRECT
<CreateButton onClick={handleCreate} />
```

---

## 10. Forms & Modals

### Standard Modal Structure

```jsx
{showModal && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div className="bg-surface rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col border border-border mx-4">

      {/* Modal header */}
      <div className="flex items-center justify-between p-6 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Icon size={20} className="text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text">{title}</h2>
            <p className="text-sm text-text-muted">{subtitle}</p>
          </div>
        </div>
        <button
          onClick={handleClose}
          className="p-2 rounded-lg hover:bg-surface-muted text-text-muted hover:text-text transition-colors"
        >
          <X size={20} />
        </button>
      </div>

      {/* Modal body */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* Form fields */}
      </div>

      {/* Modal footer — standard (non-transaction) forms */}
      {/* RTL: flex-row renders Save first (screen-right), Cancel second */}
      <div className="flex items-center gap-3 p-6 border-t border-border flex-shrink-0 flex-row">
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white hover:bg-primary-dark disabled:opacity-50 text-sm font-medium"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleClose}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-text hover:bg-surface-muted text-sm font-medium"
        >
          <X size={16} /> Cancel
        </button>
      </div>
    </div>
  </div>
)}
```

### Modal Rules

| Rule | Value |
|------|-------|
| Z-index | `z-50` |
| Max height | `max-h-[90vh]` with internal scroll |
| Width | `max-w-2xl` (simple) or `max-w-4xl` (complex) |
| Header | icon + title + X close button |
| Standard forms | Action buttons in **footer** |
| Transaction forms | Action buttons in **header** (see below) |
| Multi-tab modals | Fixed height based on tallest tab content |

### Transaction Form Modal — Buttons in Header

In transaction entry forms, Save / Post / Close buttons go in the **modal header**, not the footer:

```jsx
<div className="flex items-center justify-between p-4 border-b border-border flex-shrink-0">
  <div className="flex items-center gap-3">
    <button onClick={() => setView('list')} className="p-2 rounded-lg hover:bg-surface-muted text-text-muted">
      <ArrowRight size={20} />  {/* RTL: back = ArrowRight */}
    </button>
    <div>
      <h2 className="text-base font-semibold text-text">{documentTitle}</h2>
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span>{documentNumber}</span>
        <StatusBadge status={status} />
      </div>
    </div>
  </div>

  {/* Action buttons — RTL flex-row: Post, Save, Close left-to-right on screen */}
  <div className="flex items-center gap-2 flex-row">
    {/* Post — only for draft documents */}
    {!viewMode && editingItem?.status === 'draft' && canPost && (
      <button
        onClick={handlePost}
        disabled={posting}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 text-sm font-medium"
      >
        {posting ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle size={16} />}
        Post
      </button>
    )}
    {/* Save */}
    {!viewMode && (
      <button
        onClick={handleSave}
        disabled={saving}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-white hover:bg-primary-dark text-sm font-medium"
      >
        {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
        Save
      </button>
    )}
    {/* Close */}
    <button
      onClick={() => setView('list')}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-text hover:bg-surface-muted text-sm font-medium"
    >
      <X size={16} /> Close
    </button>
  </div>
</div>
```

---

## 11. Input Fields

### Text Field

```jsx
<div className="space-y-1">
  <label className="block text-sm font-medium text-text">
    {label}
    {required && <span className="text-red-500 ms-1">*</span>}
  </label>
  <input
    type="text"
    value={value}
    onChange={(e) => setValue(e.target.value)}
    placeholder={placeholder}
    className="w-full px-3 py-2 rounded-lg border border-border bg-control text-text
      placeholder:text-text-muted
      focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary
      hover:border-border-strong
      disabled:bg-surface-muted disabled:cursor-not-allowed disabled:text-text-muted
      text-right"
    dir="rtl"
  />
  {error && <p className="text-xs text-red-600">{error}</p>}
</div>
```

### Numeric Field — CRITICAL: `type="text"` NOT `type="number"`

```jsx
<input
  type="text"
  inputMode="decimal"
  value={value}
  onChange={handleNumericInput}
  className="w-20 px-2 py-1 border border-border rounded text-left text-sm bg-surface text-text
    focus:ring-1 focus:ring-primary"
  dir="ltr"  {/* Numbers are always LTR */}
/>
```

**Why `type="text"` over `type="number"`:**
- Removes browser spinner arrows completely
- Full control over decimal input validation
- No unexpected browser behaviour with locale decimal separators

### Date Field

```jsx
<input
  type="date"
  value={dateValue}
  onChange={(e) => setDateValue(e.target.value)}
  className="w-full px-3 py-2 rounded-lg border border-border bg-control text-text
    focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
/>
```

### Textarea

```jsx
<textarea
  value={value}
  onChange={(e) => setValue(e.target.value)}
  rows={3}
  className="w-full px-3 py-2 rounded-lg border border-border bg-control text-text
    placeholder:text-text-muted resize-none
    focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary
    text-right"
  dir="rtl"
/>
```

### Two-Column Field Grid

```jsx
<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
  <div className="space-y-1">
    <label className="block text-sm font-medium text-text">Field One *</label>
    <input ... />
  </div>
  <div className="space-y-1">
    <label className="block text-sm font-medium text-text">Field Two</label>
    <input ... />
  </div>
</div>
```

---

## 12. SearchableSelect Dropdown

```jsx
import SearchableSelect from '@/components/SearchableSelect.jsx';

<SearchableSelect
  options={optionsArray}
  value={selectedId}
  onChange={(id, obj) => handleSelection(id, obj)}
  placeholder="Select..."
  searchFields={['code', 'name']}
  formatOption={(opt) => `${opt.code} | ${opt.name}`}        // Shows in dropdown list
  formatSelectedOption={(opt) => opt.name}                   // Shows when selected
  size="default"        // "default" for form headers, "compact" for grid cells
  usePortal={true}      // Required to escape overflow clipping in modals
  // Server-side search:
  onSearch={asyncSearchFn}
  minSearchLength={2}   // Min chars before async search fires
/>
```

### Size Variants

| Size | Usage |
|------|-------|
| `"default"` | Header form fields |
| `"compact"` | Line items grid cells |
| `"small"` | Rare, minimal contexts |

### Built-in Keyboard Behavior

| Key | Action |
|-----|--------|
| `↑ / ↓` | Navigate options |
| `Enter` | Select highlighted option |
| `Escape` | Close dropdown |
| `Tab` | Close dropdown, advance to next field |
| Typing | Real-time filter |

**Rules:**
- Results appear after **2 characters** typed (server-side search).
- Always use `usePortal={true}` inside modals and `overflow-hidden` containers.

---

## 13. Search Bar

```jsx
import DebouncedSearchInput from '@/components/DebouncedSearchInput.jsx';

<DebouncedSearchInput
  value={search}
  onChange={setSearch}
  placeholder="Search..."
  debounceMs={300}
  className="max-w-xs"
/>
```

### Manual Implementation

```jsx
<div className="relative">
  {/* Search icon — right side in RTL */}
  <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted" />
  <input
    type="text"
    value={search}
    onChange={(e) => setSearch(e.target.value)}
    placeholder="Search..."
    className="w-full pr-10 pl-10 py-2 rounded-lg border border-border bg-control text-text
      placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary
      text-right"
    dir="rtl"
  />
  {/* Clear button — always visible when text is present */}
  {search && (
    <button
      onClick={() => setSearch('')}
      className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
    >
      <X size={14} />
    </button>
  )}
</div>
```

**Rules:**
- X clear button is always shown when the field contains text.
- Filtering happens on every keystroke (debounce 300ms).
- No separate "Search" button on list pages — search is instant.
- **Exception — Inquiry pages**: must have an explicit Search button that triggers the fetch.

---

## 14. Tabs

### Standard Tab Bar

```jsx
<div className="flex border-b border-border px-6">
  {tabs.map((tab) => (
    <button
      key={tab.key}
      onClick={() => setActiveTab(tab.key)}
      disabled={tab.disabled}
      title={`${tab.label} (Alt+${tab.shortcutNum})`}
      className={`
        py-3 px-4 border-b-2 font-medium text-sm transition-colors flex items-center gap-1.5
        ${activeTab === tab.key
          ? 'border-primary text-primary'
          : tab.disabled
            ? 'border-transparent text-text-muted/50 cursor-not-allowed'
            : 'border-transparent text-text-muted hover:text-text'
        }
      `}
    >
      <tab.Icon size={16} />
      {tab.label}
      {/* Line count badge on the Line Items tab */}
      {tab.count > 0 && (
        <span className="ms-2 px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
          {tab.count}
        </span>
      )}
      {/* Error indicator when header has missing required fields */}
      {tab.hasError && <span className="ms-1 text-red-500">*</span>}
    </button>
  ))}
</div>
```

### Standard Transaction Form Tabs

| # | Label | Icon | Shortcut | Condition |
|---|-------|------|----------|-----------|
| 1 | **Document Header** | `FileText` | `Alt+1` | Always visible |
| 2 | **Line Items** | `ListOrdered` | `Alt+2` | Disabled until header validates |
| 3 | **GL Distribution** | `BarChart3` | `Alt+3` | If module supports GL posting |
| 4 | **History** | `History` | `Alt+4` | Only when editing a saved document |

### Tab Content Container

```jsx
<div className="bg-surface rounded-xl border border-border">
  <div className="flex border-b border-border px-6">
    {/* Tab buttons */}
  </div>
  <div className="p-6">
    {activeTab === 'header'  && <div data-tab="header">...</div>}
    {activeTab === 'lines'   && <div data-tab="lines">...</div>}
    {activeTab === 'gl'      && <div data-tab="gl">...</div>}
    {activeTab === 'history' && <div data-tab="history">...</div>}
  </div>
</div>
```

> The `data-tab` attribute is used by the focus management system to auto-focus the first field when a tab changes.

---

## 15. Line Items Data Entry Grid

### CRITICAL Column Order (Universal Rule)

The column order is standardized across ALL transaction entry forms. Include only the columns applicable to the module.

| # | Column | Width | Required | Notes |
|---|--------|-------|----------|-------|
| 1 | **#** Row Number | 40px | Yes | 1-based, centered, non-editable |
| 2 | **Line Type** | 100px | Conditional | Only if module has multiple types (e.g., ITEM / SERVICE) |
| 3 | **Item / Service** | 280px | Yes | SearchableSelect with async search |
| 4 | **Description** | min 220px | Yes | Auto-populated, read-only, `tabIndex={-1}` |
| 5 | **UOM** | 180px | Yes | SearchableSelect. **MUST come BEFORE Quantity** |
| 6 | **Quantity** | 68px | Yes | `type="text" inputMode="decimal"` |
| 7 | **Unit Price / Cost** | 82px | Yes | `type="text" inputMode="decimal"` |
| 8 | **Discount** | 130px | Conditional | Sales / Purchasing only. % or $ toggle + input |
| 9 | **Tax %** | 70px | Conditional | If module supports line-level tax |
| 10 | **Line Total** | 110px | Yes | Calculated, display-only, bold |
| 11 | **Delete** | 40px | Yes | Trash icon, `tabIndex={-1}` |
| 12 | **Expand** | 32px | Conditional | Chevron, `tabIndex={0}` |

### Grid Container

```jsx
<div className="bg-surface rounded-lg border border-border overflow-x-auto">
  <table className="w-full text-sm">
    <thead>
      <tr className="bg-surface-muted text-text-muted text-xs uppercase tracking-wider">
        <th className="px-3 py-2 text-center w-10">#</th>
        <th className="px-3 py-2 text-right w-72">Item</th>
        <th className="px-3 py-2 text-right min-w-[220px]">Description</th>
        <th className="px-3 py-2 text-right min-w-[180px]">UOM</th>   {/* BEFORE Qty */}
        <th className="px-3 py-2 text-left w-16">Qty</th>
        <th className="px-3 py-2 text-left w-20">Unit Price</th>
        <th className="px-3 py-2 text-left w-28">Total</th>
        <th className="px-3 py-2 text-center w-10">Del</th>
      </tr>
    </thead>
    <tbody className="divide-y divide-border/50">
      {lines.map((line, idx) => (
        <tr key={idx} data-sop-row={idx} className="hover:bg-surface-muted/30">
          {/* row cells */}
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

### Description Field (Read-Only, Tab-Skipped)

```jsx
<input
  type="text"
  value={line.description}
  readOnly
  tabIndex={-1}
  className="w-full px-2 py-1 border border-border rounded text-sm bg-surface-muted text-text cursor-default"
/>
```

### Quantity / Price Field

```jsx
<input
  type="text"
  inputMode="decimal"
  value={line.quantity}
  onChange={(e) => handleNumericInput(e, idx, 'quantity')}
  onBlur={() => {
    // Auto-open lot/serial modal for tracked items when qty changes
    if (isTrackedItem(line) && parseFloat(line.quantity) > 0) {
      openLotSerialModal(idx, line);
    }
  }}
  className="w-16 px-2 py-1 border border-border rounded text-left text-sm bg-surface text-text focus:ring-1 focus:ring-primary"
  dir="ltr"
/>
```

### Delete Button (Row)

```jsx
<button
  type="button"
  tabIndex={-1}
  onClick={() => removeLine(idx)}
  className="p-1 rounded text-red-400 hover:text-red-600 hover:bg-red-50"
>
  <Trash2 size={14} />
</button>
```

### Add Line Button

```jsx
<div className="text-center py-2">
  <button
    type="button"
    onClick={addLine}
    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary hover:text-primary-dark hover:bg-surface-muted rounded transition-colors"
  >
    <Plus size={16} />
    + Add Line
  </button>
</div>
```

### Discount Field (Toggle + Input)

```
┌──────┬──────────────────┐
│  %   │  0.00            │   ← % / $ toggle + numeric input
└──────┴──────────────────┘
```

```jsx
<div className="flex items-center">
  <button
    type="button"
    tabIndex={-1}
    onClick={() => toggleDiscountType(idx)}
    className="w-8 py-1 border border-e-0 border-border rounded-s bg-surface-muted text-text-muted text-xs text-center hover:bg-surface-muted/80 shrink-0"
  >
    {discountType === 'percent' ? '%' : currencySymbol}
  </button>
  <input
    type="text"
    inputMode="decimal"
    value={line.discountValue || 0}
    onChange={(e) => handleNumericInput(e, idx, 'discountValue')}
    className="flex-1 min-w-0 px-2 py-1 border border-border rounded-e text-left text-sm bg-surface text-text focus:ring-1 focus:ring-primary"
    dir="ltr"
  />
</div>
```

### Minimum Lines Rule

- The grid must always have at least **one row** even if empty.
- When the last row is deleted, replace it with a fresh empty `createLineState()`.

### Standard Numeric Input Handler

```javascript
const handleNumericInput = useCallback((e, idx, field) => {
  let raw = e.target.value;
  raw = raw.replace(/^0+(\d)/, '$1');  // Strip leading zeros (preserve "0." patterns)
  const num = Number(raw);
  if (raw === '' || raw === '0' || raw === '0.') {
    updateField(idx, field, raw === '' ? 0 : Number(raw) || 0);
    e.target.value = raw;
    return;
  }
  if (!isNaN(num)) {
    updateField(idx, field, num);
    e.target.value = raw;
  }
  // If NaN — reject the character silently (no state update)
}, [updateField]);
```

---

## 16. Totals Section

```jsx
<div className="flex justify-start">  {/* RTL: justify-start = left edge of screen */}
  <div className="w-full max-w-md space-y-2 p-4 bg-surface-muted/50 rounded-lg border border-border">

    {/* Subtotal */}
    <div className="flex justify-between text-sm">
      <span className="text-text-muted">Subtotal:</span>
      <span className="text-text font-medium">{currencySymbol}{formatAmount(subtotal)}</span>
    </div>

    {/* Line discounts — only if > 0, shown in red */}
    {lineDiscounts > 0 && (
      <div className="flex justify-between text-sm">
        <span className="text-text-muted">Line Discounts:</span>
        <span className="text-red-600 font-medium">-{currencySymbol}{formatAmount(lineDiscounts)}</span>
      </div>
    )}

    {/* Tax — only if > 0 */}
    {tax > 0 && (
      <div className="flex justify-between text-sm">
        <span className="text-text-muted">Tax:</span>
        <span className="text-text font-medium">{currencySymbol}{formatAmount(tax)}</span>
      </div>
    )}

    {/* Grand total */}
    <div className="border-t-2 border-border pt-2">
      <div className="flex justify-between text-base font-bold">
        <span className="text-text">Grand Total:</span>
        <span className="text-text">{currencySymbol}{formatAmount(grandTotal)}</span>
      </div>
    </div>
  </div>
</div>
```

---

## 17. Status Badges

```jsx
const statusColors = {
  // Transaction statuses
  draft:     'bg-gray-100 text-gray-700',
  new:       'bg-blue-100 text-blue-800',
  released:  'bg-green-100 text-green-800',
  posted:    'bg-green-100 text-green-800',
  pending:   'bg-yellow-100 text-yellow-800',
  approved:  'bg-green-100 text-green-800',
  rejected:  'bg-red-100 text-red-800',
  cancelled: 'bg-red-100 text-red-800',
  closed:    'bg-gray-100 text-gray-800',
  received:  'bg-purple-100 text-purple-800',
  // Entity statuses
  active:    'bg-green-100 text-green-700',
  inactive:  'bg-gray-100 text-gray-500',
  on_hold:   'bg-amber-100 text-amber-800',
};

const StatusBadge = ({ status, label }) => (
  <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColors[status] ?? 'bg-gray-100 text-gray-800'}`}>
    {label ?? status}
  </span>
);
```

### Status Color Reference

| Status | Background | Text |
|--------|-----------|------|
| Draft | `bg-gray-100` | `text-gray-700` |
| New | `bg-blue-100` | `text-blue-800` |
| Posted / Approved / Released | `bg-green-100` | `text-green-800` |
| Pending / Under Review | `bg-yellow-100` | `text-yellow-800` |
| Rejected / Cancelled | `bg-red-100` | `text-red-800` |
| Closed / Inactive | `bg-gray-100` | `text-gray-800` |
| Received / Completed | `bg-purple-100` | `text-purple-800` |
| Active | `bg-green-100` | `text-green-700` |
| On Hold | `bg-amber-100` | `text-amber-800` |

---

## 18. Dashboard KPI Cards

```jsx
const KpiCard = ({ icon: Icon, label, value, sub, colorClass, bgClass }) => (
  <div className="flex items-center gap-4 rounded-xl border border-border bg-surface p-4">
    <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${bgClass}`}>
      <Icon size={22} className={colorClass} />
    </div>
    <div className="min-w-0">
      <p className="truncate text-sm text-text-muted">{label}</p>
      <p className="text-2xl font-semibold text-text">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-muted">{sub}</p>}
    </div>
  </div>
);

// Grid layout
<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
  {kpiCards.map((card, i) => <KpiCard key={i} {...card} />)}
</div>
```

### KPI Color Combinations

| Meaning | bgClass | colorClass |
|---------|---------|------------|
| General / primary | `bg-primary/10` | `text-primary` |
| Total / count | `bg-blue-600` | `text-white` |
| Positive / financial value | `bg-emerald-600` | `text-white` |
| Warning / low stock | `bg-amber-500` | `text-white` |
| Critical / zero | `bg-red-600` | `text-white` |
| Neutral / informational | `bg-slate-600` | `text-white` |

---

## 19. Section Headers & Info Cards

### Section Header

```jsx
<div className="flex items-center gap-3 mb-5">
  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
    <Icon size={18} className="text-primary" />
  </div>
  <div>
    <h2 className="text-base font-semibold text-text">{title}</h2>
    {subtitle && <p className="text-sm text-text-muted">{subtitle}</p>}
  </div>
</div>
```

### Expanded Row Info Box

Used inside expanded grid rows to show extra field details:

```jsx
<div className="bg-surface rounded-lg border border-border px-3 py-2">
  <span className="text-[10px] uppercase tracking-wider text-text-muted block mb-0.5">
    {label}
  </span>
  <span className="text-sm text-text font-semibold">{value}</span>
</div>
```

### Feature / Overview Card

```jsx
<div className="group flex cursor-default flex-col gap-3 rounded-xl border border-border bg-surface p-5 transition-colors hover:bg-surface-muted/50">
  <div className="flex items-start justify-between">
    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
      <Icon size={20} className="text-primary" />
    </div>
    {badge && (
      <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
        {badge}
      </span>
    )}
  </div>
  <div>
    <h4 className="font-semibold text-text">{title}</h4>
    <p className="mt-1 text-sm text-text-muted">{description}</p>
  </div>
</div>
```

---

## 20. Pagination

```jsx
<div className="flex items-center justify-between px-4 py-3 border-t border-border bg-surface-muted/50 text-sm">
  {/* Record count */}
  <span className="text-text-muted">
    Showing {from}–{to} of {total} records
  </span>

  <div className="flex items-center gap-1">
    {/* Previous — RTL: ChevronRight points left visually = previous */}
    <button
      onClick={() => setPage(p => Math.max(1, p - 1))}
      disabled={page === 1}
      className="p-2 rounded-lg hover:bg-surface-muted text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      <ChevronRight size={16} />
    </button>

    {/* Page number buttons */}
    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => i + 1).map(pageNum => (
      <button
        key={pageNum}
        onClick={() => setPage(pageNum)}
        className={`w-8 h-8 rounded-lg text-sm font-medium transition-colors ${
          page === pageNum
            ? 'bg-primary text-white'
            : 'text-text-muted hover:bg-surface-muted hover:text-text'
        }`}
      >
        {pageNum}
      </button>
    ))}

    {/* Next — RTL: ChevronLeft points right visually = next */}
    <button
      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
      disabled={page === totalPages}
      className="p-2 rounded-lg hover:bg-surface-muted text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      <ChevronLeft size={16} />
    </button>
  </div>
</div>
```

---

## 21. Toast Notifications

**`alert()`, `window.alert()`, and `window.confirm()` are STRICTLY FORBIDDEN everywhere in the application.**

```jsx
import { useToast } from '@/components/Toast.jsx';

const toast = useToast();

toast.success('Record saved successfully');
toast.error(err.response?.data?.error || err.message || 'An error occurred');
toast.warning('Please fill in all required fields');
toast.info('No records found for the selected period');
```

### When to Use Each Variant

| Situation | Method |
|-----------|--------|
| Record saved / action succeeded | `toast.success(...)` |
| API error in catch block | `toast.error(...)` |
| Validation failure | `toast.warning(...)` |
| Neutral informational result | `toast.info(...)` |

### Pattern for Catch Blocks

```jsx
try {
  await client.post('/resource', payload);
  toast.success('Saved successfully');
} catch (err) {
  toast.error(err.response?.data?.error || err.message || 'Save failed');
}
```

---

## 22. Confirm Dialogs

```jsx
import { useConfirm } from '@/components/ConfirmDialog.jsx';

const confirm = useConfirm();

const handleDelete = async (id) => {
  const ok = await confirm({
    title: 'Are you sure you want to delete this record?',
    message: 'This action cannot be undone.',
    variant: 'danger',        // 'danger' | 'caution' | 'neutral'
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
  });
  if (!ok) return;
  try {
    await client.delete(`/resource/${id}`);
    toast.success('Deleted successfully');
    refetch();
  } catch (err) {
    toast.error(err.message);
  }
};
```

### Variant Guide

| Variant | Confirm Button Color | Use for |
|---------|---------------------|---------|
| `'danger'` | Red | Delete, void, remove, purge |
| `'caution'` | Amber | Post, close period, deactivate, irreversible financial ops |
| `'neutral'` | Primary blue | General confirmations |

### Anti-Pattern

```jsx
// ❌ FORBIDDEN
if (window.confirm('Are you sure?')) { ... }

// ✅ CORRECT
const ok = await confirm({ title: 'Are you sure?', variant: 'danger', confirmLabel: 'Delete' });
if (!ok) return;
```

> The calling function **must** be declared `async` because `confirm()` returns a Promise.

---

## 23. Keyboard Shortcuts Panel

```jsx
import KeyboardShortcutsPanel from '@/components/KeyboardShortcutsPanel.jsx';
import useKeyboardShortcuts from '@/hooks/useKeyboardShortcuts.js';

// Register shortcuts
const formShortcuts = useMemo(() => [
  { key: '1', alt: true,  handler: () => setActiveTab('header'),  enabled: !isModalOpen },
  { key: '2', alt: true,  handler: () => setActiveTab('lines'),   enabled: !isModalOpen },
  { key: '3', alt: true,  handler: () => setActiveTab('gl'),      enabled: !isModalOpen },
  { key: '4', alt: true,  handler: () => setActiveTab('history'), enabled: !isModalOpen },
  { key: 's', alt: true,  handler: handleSave,    enabled: !readOnly },
  { key: 'p', alt: true,  handler: handlePrint,   enabled: true },  // Always intercept Alt+P
  { key: 'Escape',        handler: handleClose,   enabled: !isModalOpen },
], [/* deps */]);

useKeyboardShortcuts(formShortcuts, view === 'form');

// Render help panel (floating FAB)
<KeyboardShortcutsPanel shortcuts={[
  { label: 'Document Header', shortcut: { key: '1', alt: true },              category: 'Navigation' },
  { label: 'Line Items',      shortcut: { key: '2', alt: true },              category: 'Navigation' },
  { label: 'Close',           shortcut: { key: 'Escape' },                    category: 'Navigation' },
  { label: 'Save',            shortcut: { key: 'S', alt: true },              category: 'Actions' },
  { label: 'Post',            shortcut: { key: 'P', alt: true, shift: true }, category: 'Actions' },
  { label: 'Print',           shortcut: { key: 'P', alt: true },              category: 'Actions' },
  { label: 'New Line',        shortcut: { key: 'N', alt: true },              category: 'Editing' },
]} />
```

### Standard Shortcuts for All Transaction Forms

| Shortcut | Action |
|----------|--------|
| `Alt+1` | Switch to Document Header tab |
| `Alt+2` | Switch to Line Items tab |
| `Alt+3` | Switch to third tab (GL Distribution) |
| `Alt+4` | Switch to History tab |
| `Alt+S` | Save document |
| `Alt+P` | Print (always intercept to prevent browser print dialog) |
| `Alt+Shift+P` | Post document |
| `Escape` | Close / back to list |
| `Alt+N` | Add new line (when on Lines tab) |
| `Alt+Delete` | Delete focused line |

> All shortcuts must be disabled when any modal is open (`enabled: !isModalOpen`).

---

## 24. Loading States

### Skeleton Loader

```jsx
{loading ? (
  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    {Array.from({ length: 8 }).map((_, i) => (
      <div key={i} className="h-24 animate-pulse rounded-xl border border-border bg-surface-muted" />
    ))}
  </div>
) : (
  <div>{/* actual content */}</div>
)}
```

### Button Loading Indicator

```jsx
<button disabled={saving}>
  {saving ? (
    <><Loader2 size={16} className="animate-spin" /> Saving...</>
  ) : (
    <><Save size={16} /> Save</>
  )}
</button>
```

### Page-Level Spinner

```jsx
{loading && (
  <div className="flex items-center justify-center py-16">
    <Loader2 size={32} className="animate-spin text-primary" />
  </div>
)}
```

---

## 25. Empty States

```jsx
{!loading && items.length === 0 && (
  <div className="flex flex-col items-center justify-center py-16 text-center">
    <Icon className="w-16 h-16 text-text-muted/50 mb-4" />
    <h3 className="text-lg font-medium text-text mb-2">No records found</h3>
    <p className="text-text-muted max-w-md mb-6">
      Get started by creating your first record.
    </p>
    {canCreate && <CreateButton onClick={handleCreate} />}
  </div>
)}
```

---

## 26. Validation Rules

### Field-Level Validation

| Field Type | Rule |
|-----------|------|
| Text | Max length per DB schema; required when mandatory |
| Numbers | No non-numeric characters; range check at save/post |
| Dates | Valid `YYYY-MM-DD` format; range check if applicable |
| Email | Pattern: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` |
| Phone | Iraqi format: `07XXXXXXXX` (10 digits, must start with `07`) |
| Required fields | Block form submission when empty |
| Unique codes | Auto-generated: `0000000001`, `0000000002`, … |

### Fiscal Period Validation (Mandatory on Every Transaction)

Every transaction (sales, purchasing, inventory, GL, payroll, project) MUST validate that the fiscal period is open **before saving and before posting**:

```javascript
import { validateFiscalPeriod } from '@/utils/fiscal-period-check.js';

// moduleName: 'financial' | 'sales' | 'purchasing' | 'inventory' | 'payroll' | 'project'
const validation = await validateFiscalPeriod(transactionDate, 'sales');
if (!validation.isValid) {
  toast.error(validation.message);
  return;
}
```

### Validation Error Display

| Error Type | How to Display |
|-----------|---------------|
| Form-level missing fields | Red banner at top of form |
| Business rule warning | `toast.warning(message)` |
| API / save error | `toast.error(message)` |
| Per-cell errors in grids | Not used — validate at save/post time only |

```jsx
{banner && (
  <div className={`px-4 py-3 rounded-lg text-sm font-medium mb-4 ${
    banner.type === 'success'
      ? 'bg-green-50 text-green-800 border border-green-200'
      : 'bg-red-50 text-red-800 border border-red-200'
  }`}>
    {banner.message}
  </div>
)}
```

---

## 27. Focus & Keyboard Navigation Rules

### Auto-Focus on Modal / Form Open

```javascript
useEffect(() => {
  if (showModal) {
    setTimeout(() => {
      const firstInput = document.querySelector(
        '.modal-content input:not([disabled]):not([readonly]), .modal-content [role="combobox"]'
      );
      firstInput?.focus();
    }, 100);
  }
}, [showModal]);
```

### Auto-Focus on Tab Change (Transaction Forms)

```javascript
const focusFirstField = (tab) => {
  setTimeout(() => {
    const container = document.querySelector(`[data-tab="${tab}"]`);
    if (!container) return;
    const focusable = container.querySelectorAll(
      '[role="combobox"]:not([tabindex="-1"]), input:not([disabled]):not([readonly]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])'
    );
    for (const el of focusable) {
      if (el.offsetParent !== null) { el.focus(); return; }
    }
  }, 150);
};
```

### tabIndex Rules

| Element | tabIndex | Reason |
|---------|----------|--------|
| Header form fields | `0` (default) | Natural tab order |
| Description input (read-only) | `-1` | Skip during Tab navigation |
| Row delete button | `-1` | Use `Alt+Delete` instead |
| Row expand button | `0` | Keyboard accessible via Enter / Space |
| Discount type toggle button | `-1` | Mouse-only toggle |

> **CRITICAL**: Never use positive `tabIndex` values (1, 2, 3…). Only `0` or `-1` are allowed. Positive values break natural DOM tab order.

### Header → Lines Auto-Switch (Last Header Field)

```jsx
<textarea
  onKeyDown={(e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      if (headerIsValid) {
        setActiveTab('lines');
      } else {
        setBanner({ type: 'error', message: 'Please complete all required header fields' });
      }
    }
  }}
/>
```

### Tab on Last Field of Last Row → Add New Row

```javascript
const handleLastFieldKeyDown = (e, idx) => {
  if (e.key === 'Tab' && !e.shiftKey && idx === lines.length - 1) {
    if (!isLastLineComplete()) return;
    e.preventDefault();
    addNewLine();
    setTimeout(() => {
      const newRow = document.querySelector(`[data-sop-row="${idx + 1}"] [role="combobox"]`);
      newRow?.focus();
    }, 50);
  }
};
```

---

## 28. Transaction Form Lifecycle

```
Create New ──→ Save (form stays open in edit mode) ──→ Post ──→ Read-Only View
    ↑                          ↑
 mode='create'            status='draft'
 editingItem=null         editingItem != null
```

### CRITICAL — After Save, Form Must Stay Open

```javascript
// After successful save: reload the saved document in edit mode — do NOT close the form
const savedId = saveResponse.data.id;
const reloadedData = await client.get(`/module/documents/${savedId}`);
loadDocumentIntoForm(reloadedData.data, 'edit');
// User can now Post directly without closing and re-finding the record
```

### Button Visibility Rules

| Button | Visible When | Style |
|--------|-------------|-------|
| Save | `!readOnly` | `bg-primary text-white` |
| Post | `!viewMode && editingItem?.status === 'draft' && canPost` | `bg-green-600 text-white` |
| Close | Always | `border border-border text-text hover:bg-surface-muted` |

### Read-Only Mode

```javascript
const readOnly = mode === 'view' || (editingItem && editingItem.status !== 'draft');
```

When `readOnly = true`:
- All inputs get `disabled` prop.
- Line items grid receives `onChange={undefined}` — renders static display instead of inputs.
- Save button is hidden.

---

## 29. Implementation Checklist

### Layout & General Styling

- [ ] Only CSS variable classes used — zero hardcoded colors (`bg-blue-600`, `text-slate-700`, etc.)
- [ ] Page background: `bg-surface-muted`
- [ ] Cards and tables: `bg-surface rounded-xl border border-border`
- [ ] Table header row: `bg-surface-muted text-text-muted text-xs uppercase tracking-wider`
- [ ] Table row dividers: `divide-y divide-border`
- [ ] Table row hover: `hover:bg-surface-muted/50`

### Page Header

- [ ] Icon container: `w-10 h-10 rounded-lg bg-primary/10`, icon: `text-primary`
- [ ] Title: `text-xl font-bold text-text`
- [ ] Subtitle: `text-sm text-text-muted`

### Toolbar

- [ ] Using `<CreateButton />` — not a custom button with hardcoded classes
- [ ] Using `<ExportButton />` and `<ImportButton />`
- [ ] RTL button order: Create → Export → Import (`flex-row`)
- [ ] Search field has X clear button when text is present

### Data Grid

- [ ] `ExpandableActions` on every row — no raw icon buttons
- [ ] Numbers / amounts: `text-left` (`dir="ltr"`)
- [ ] Text fields: `text-right`
- [ ] Status badges and actions: `text-center`
- [ ] Record name / code is a clickable link that opens the detail view

### Forms & Modals

- [ ] Auto-focus on first field when form or modal opens
- [ ] Standard forms: Save / Cancel buttons in **modal footer**
- [ ] Transaction forms: Save / Post / Close buttons in **modal header**
- [ ] After save: form stays open in edit mode (not closed)
- [ ] `alert()` and `window.confirm()` are absent from the entire file

### Line Items Grid

- [ ] UOM column is **before** the Quantity column — always
- [ ] All numeric fields: `type="text" inputMode="decimal"` — NOT `type="number"`
- [ ] `data-sop-row={idx}` attribute on every data row
- [ ] At least one empty row always present
- [ ] Tab on last field of last row adds a new row automatically
- [ ] Description field: `readOnly tabIndex={-1}`
- [ ] Delete button in row: `tabIndex={-1}`

### Tabs (Transaction Forms)

- [ ] Tab labels: "Document Header", "Line Items", "GL Distribution", "History"
- [ ] Icons: `FileText`, `ListOrdered`, `BarChart3`, `History`
- [ ] Tab shortcuts: `Alt+1`, `Alt+2`, `Alt+3`, `Alt+4`
- [ ] Line Items tab disabled until header fields are valid
- [ ] History tab only visible when editing a saved document

### Notifications & Confirmations

- [ ] `toast.success(...)` for all save / action success messages
- [ ] `toast.error(...)` in all catch blocks
- [ ] `toast.warning(...)` for validation failures
- [ ] `await confirm({ variant: 'danger' })` for all delete actions
- [ ] `await confirm({ variant: 'caution' })` for post / financial close actions
- [ ] Zero uses of `alert()`, `window.alert()`, `window.confirm()`

### Tile Menu

- [ ] Tile grid: `grid-cols-2 sm:grid-cols-3 ... xl:grid-cols-6`
- [ ] Active tile: `bg-primary/10 border-2 border-primary/30`
- [ ] Tile icon container: `bg-primary`, icon: `text-on-primary`
- [ ] Expanded content: `bg-primary/5 border-2 border-primary/20 animate-in slide-in-from-top-4`
- [ ] Subgroup heading: horizontal rule + `uppercase tracking-wide` label

---

## Appendix A: Shared Component Map

| Component | Path | Purpose |
|-----------|------|---------|
| `SearchableSelect` | `src/components/SearchableSelect.jsx` | Searchable dropdown |
| `ExpandableActions` | `src/components/ExpandableActions.jsx` | Row action speed-dial menu |
| `CreateButton`, `ExportButton`, `ImportButton` | `src/components/IconButtons.jsx` | Standard toolbar buttons |
| `DebouncedSearchInput` | `src/components/DebouncedSearchInput.jsx` | Search field with debounce |
| `TransactionHistoryTab` | `src/components/TransactionHistoryTab.jsx` | History timeline tab |
| `KeyboardShortcutsPanel` | `src/components/KeyboardShortcutsPanel.jsx` | Floating shortcuts help FAB |
| `useToast` | `src/components/Toast.jsx` | Toast notification hook |
| `useConfirm` | `src/components/ConfirmDialog.jsx` | Confirmation dialog hook |
| `useKeyboardShortcuts` | `src/hooks/useKeyboardShortcuts.js` | Keyboard shortcut registration |
| `ImportModal` | `src/components/ImportModal.jsx` | Excel import modal |
| `ActionButton`, `IconActionButton` | `src/components/ActionButton.jsx` | Buttons with async loading state |

## Appendix B: Reference Source Files

| Pattern | Reference File |
|---------|---------------|
| Tile Menu (home page) | `src/components/TileMenu.jsx` |
| List page — search + grid | `src/features/sales/SalesCustomersPage.jsx` |
| Transaction form — header / lines / history | `src/features/sales/SalesTransactionsPage.jsx` |
| Line items grid | `src/features/purchasing/PurchaseOrdersPage.jsx` |
| Dashboard — KPI cards + charts | `src/features/inventory/InventoryDashboardPage.jsx` |
| App shell structure | `src/components/ShellLayout.jsx` |
| Theme tokens (CSS variables) | `src/index.css` |

## Appendix C: createLineState() Template

```javascript
const createLineState = () => ({
  lineType: 'ITEM',         // omit if module has only one line type
  itemId: '',
  serviceId: '',            // only if module supports service lines
  description: '',
  uomId: '',
  quantity: 1,
  unitPrice: 0,
  discountType: 'percent',  // only if module supports discounts
  discountValue: 0,
  taxPercent: 0,            // only if module supports line-level tax
});
```

## Appendix D: Decimal Places Resolution

| Field | Source of Truth |
|-------|----------------|
| Quantity | `UOM.decimalPlaces ?? currency.decimalPlaces ?? 2` |
| Unit Price / Cost | `currency.decimalPlaces ?? 2` |
| Discount Amount | `currency.decimalPlaces ?? 2` |
| Discount Percent | Fixed 2 |
| Line Total | `currency.decimalPlaces ?? 2` |
| Display formatting | `Number.toLocaleString(locale, { minimumFractionDigits, maximumFractionDigits })` |
| Input handling | No rounding at input time — raw value stored as typed |

## Appendix E: Arabic UI Labels (Translation Reference)

When the application language is Arabic (`i18n.language === 'ar'`), the following standard labels apply. Use these exact Arabic strings in translation files (`ar.json`):

| English Label | Arabic Translation |
|--------------|-------------------|
| Document Header | رأس المستند |
| Line Items | بنود الطلب |
| GL Distribution | توزيع دفتر الأستاذ |
| History | السجل |
| Save | حفظ |
| Post | ترحيل |
| Close | إغلاق |
| Cancel | إلغاء |
| Delete | حذف |
| Edit | تعديل |
| View | عرض |
| Create | إنشاء |
| Export | تصدير |
| Import | استيراد |
| Search | بحث |
| Add Line | إضافة سطر |
| Grand Total | الإجمالي الكلي |
| Subtotal | المجموع الجزئي |
| Tax | الضريبة |
| Discount | الخصم |
| Quantity | الكمية |
| Unit Price | سعر الوحدة |
| Description | الوصف |
| Status | الحالة |
| Active | نشط |
| Inactive | غير نشط |
| Draft | مسودة |
| Posted | مرحّل |
| Approved | موافق عليه |
| Rejected | مرفوض |
| Cancelled | ملغى |
| Pending | معلّق |
| Saving... | جاري الحفظ... |
| Loading... | جاري التحميل... |
| No records found | لا توجد سجلات |
| Are you sure? | هل أنت متأكد؟ |
| This action cannot be undone | لا يمكن التراجع عن هذا الإجراء |
| Saved successfully | تم الحفظ بنجاح |
| Deleted successfully | تم الحذف بنجاح |
