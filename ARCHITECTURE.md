# Sales Dashboard — Deep Architecture Document

> **Version**: 3.0 · **Last updated**: 2026-02-16  
> Covers every layer of the system: data download, storage, processing, querying, rendering, and deployment.

---

## Table of Contents

1. [Technology Stack & Dependencies](#1-technology-stack--dependencies)
2. [Build & Deployment Pipeline](#2-build--deployment-pipeline)
3. [Application Routing & Page Structure](#3-application-routing--page-structure)
4. [Threading Model — Main Thread vs Web Worker](#4-threading-model--main-thread-vs-web-worker)
5. [Data Download Pipeline (API → Browser)](#5-data-download-pipeline-api--browser)
6. [Storage Layer — SQLite WASM on OPFS](#6-storage-layer--sqlite-wasm-on-opfs)
7. [Database Schema (Every Table, Column & Index)](#7-database-schema-every-table-column--index)
8. [Data Insertion Engine](#8-data-insertion-engine)
9. [Pre-Aggregation Engine](#9-pre-aggregation-engine)
10. [Query Engine — Dual-Path Architecture](#10-query-engine--dual-path-architecture)
11. [Extended Dashboard Data](#11-extended-dashboard-data)
12. [Dynamic Card Engine](#12-dynamic-card-engine)
13. [LRU Result Cache](#13-lru-result-cache)
14. [Worker ↔ UI Message Protocol](#14-worker--ui-message-protocol)
15. [useWorker Hook — The Bridge](#15-useworker-hook--the-bridge)
16. [Dashboard Page — Rendering Architecture](#16-dashboard-page--rendering-architecture)
17. [Cache Management Page](#17-cache-management-page)
18. [Performance Optimization Summary](#18-performance-optimization-summary)

---

## 1. Technology Stack & Dependencies

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| **UI Framework** | React | 19.2 | Component rendering, state management |
| **Bundler** | Vite | 7.3 | Dev server, HMR, code splitting |
| **Styling** | TailwindCSS | 3.4 | Utility-first CSS |
| **Routing** | React Router DOM | 7.13 | SPA routing, protected routes |
| **Charts** | Recharts | 3.7 | Bar, Line, Area, Pie, Treemap charts |
| **Icons** | Lucide React | 0.563 | Icon system |
| **Database** | `@sqlite.org/sqlite-wasm` | 3.51.2-build6 | Full SQLite compiled to WebAssembly |
| **HTTP Client** | Axios | 1.13 (UI auth), `fetch()` (Worker) | API communication |
| **Hosting** | Netlify | — | Static hosting + API proxy |

### Why These Choices

- **SQLite WASM** was chosen over IndexedDB because IndexedDB cannot perform complex SQL JOINs, GROUP BYs, or analytical queries natively. SQLite gives full SQL capability at near-native speed via WebAssembly.
- **OPFS (Origin Private File System)** provides persistent file storage that SQLite WASM can access synchronously from a Web Worker, enabling WAL-mode and POSIX-like file I/O. This means **data survives page reloads** without re-downloading.
- **Web Workers** offload all database I/O and computation off the Main Thread, ensuring the UI stays responsive even during heavy queries on 100K+ voucher datasets.
- **Recharts** was chosen for its React-first API and lazy-loadable bundle (manually chunked via Vite's `manualChunks`).

---

## 2. Build & Deployment Pipeline

### Vite Configuration (`vite.config.js`)

```js
{
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'https://www.itcatalystindia.com/Development/CustomerPortal_API',
        changeOrigin: true,
        secure: false,
      }
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',         // Required for OPFS
      'Cross-Origin-Embedder-Policy': 'require-corp',       // Required for SharedArrayBuffer
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          recharts: ['recharts'],  // Isolate Recharts into a separate chunk (~200KB)
        }
      }
    }
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],  // Do NOT pre-bundle the WASM module
  },
  worker: {
    format: 'es',  // Workers use ES modules
  }
}
```

**Critical Headers**: The COOP/COEP headers are mandatory. Without them, `SharedArrayBuffer` (required by SQLite WASM's OPFS VFS) will be disabled by the browser, and the database will silently fall back to an in-memory DB that loses data on reload.

### Netlify Configuration (`netlify.toml`)

```toml
[build]
  command = "npm run build"
  publish = "dist"

# API proxy — MUST come before the SPA catch-all
[[redirects]]
  from = "/api/*"
  to = "https://www.itcatalystindia.com/Development/CustomerPortal_API/api/:splat"
  status = 200
  force = true

# SPA fallback
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

**Flow**: In dev, Vite proxies `/api/*` to the backend. In production, Netlify's redirect rules handle the same proxy transparently. The SPA never talks to the backend directly — always through the same-origin `/api/*` path.

---

## 3. Application Routing & Page Structure

```
App.jsx
├── /login           → Login.jsx          (Public)
├── /companies       → CompanyList.jsx     (Protected)
└── /dashboard       → Layout.jsx          (Protected, wraps Sidebar + Outlet)
    ├── /sales       → Dashboard.jsx       (Sales analytics)
    └── /cache        → CacheManagement.jsx (Download / sync controls)
```

**Authentication**: `ProtectedRoute` checks `localStorage.token`. If absent, user is redirected to `/login`. Token is attached to all API calls via an Axios request interceptor (`api/axios.js`).

**State Flow**: `selectedCompany` is stored in `localStorage` as a JSON object containing:
- `company` (name)
- `guid` (unique company identifier — used as the primary key/scope for all DB operations)
- `tallyloc_id` (Tally server location ID)

---

## 4. Threading Model — Main Thread vs Web Worker

```
┌─────────────────────────────────────────────────┐
│                  Main Thread                     │
│                                                  │
│  React App                                       │
│  ├── Dashboard.jsx       ← reads dashboardData   │
│  ├── CacheManagement.jsx ← reads stats/progress  │
│  └── useWorker.js        ← bridge to worker      │
│        │                                         │
│        │ postMessage() / onmessage               │
│        ▼                                         │
├─────────────────────────────────────────────────┤
│               Web Worker Thread                   │
│                                                  │
│  sqlite-worker.js (1096 lines)                   │
│  ├── SQLite WASM (via @sqlite.org/sqlite-wasm)   │
│  ├── OPFS-backed database: /sales_cache.db       │
│  ├── Data download (fetch + insert)              │
│  ├── Pre-aggregation engine                      │
│  ├── Query engine (dual-path)                    │
│  ├── Dynamic card engine                         │
│  └── LRU result cache (in-memory, 20 entries)    │
│                                                  │
│      ┌─────────────────┐                         │
│      │ /sales_cache.db │ ← OPFS (persistent)     │
│      └─────────────────┘                         │
└─────────────────────────────────────────────────┘
```

**Why a Web Worker?**
- SQLite WASM's OPFS VFS requires synchronous file access, which is only available inside a Web Worker (not on the main thread).
- All database operations (downloads, queries, aggregations) run without blocking the UI. The user can interact with the app while data is being downloaded or queried.
- The Worker processes messages **strictly sequentially (FIFO)** — there is no concurrent query execution. This prevents race conditions on the single SQLite connection.

---

## 5. Data Download Pipeline (API → Browser)

This is the most complex part of the system. Here is the complete flow:

### 5.1 Trigger

The user navigates to **Cache Management** (`/dashboard/cache`) and clicks **Download**. This calls:

```js
sendMessage('download', {
    tallyloc_id: company.tallyloc_id,
    company: company.company,
    guid: company.guid,
    fromdate: '20250401',   // YYYYMMDD format
    todate: '20260216',
    token: 'Bearer ...',
});
```

### 5.2 Date Chunking (`chunkDates()`)

The date range is split into **2-day chunks** to avoid API timeouts and browser memory pressure.

```
Input:  fromdate=20250401, todate=20250410
Output: [
  { from: '20250401', to: '20250402' },
  { from: '20250403', to: '20250404' },
  { from: '20250405', to: '20250406' },
  { from: '20250407', to: '20250408' },
  { from: '20250409', to: '20250410' },
]
```

**Algorithm**: Start cursor at `fromdate`. Advance by 1 day for each chunk end. If the chunk end exceeds `todate`, clamp it. Advance cursor past the chunk end + 1 day.

### 5.3 Sequential Fetching with Retries (`fetchChunkWithRetry()`)

Each chunk is fetched **sequentially** (not in parallel) to avoid overwhelming the backend server.

**API Endpoint**: `POST /api/reports/salesextract`

**Request Payload** (per chunk):
```json
{
    "tallyloc_id": "abc123",
    "company": "My Company",
    "guid": "company-guid",
    "fromdate": "20250401",
    "todate": "20250402",
    "lastaltid": 0,
    "serverslice": "No",
    "vouchertype": "$$isSales, $$IsCreditNote"
}
```

| Parameter | Purpose |
|---|---|
| `tallyloc_id` | Identifies which Tally server to query |
| `company` | Company name in Tally |
| `guid` | Unique company GUID (scopes all DB operations) |
| `fromdate` / `todate` | Date range for this chunk (YYYYMMDD) |
| `lastaltid` | For incremental updates — fetch only records newer than this alter ID |
| `serverslice` | Whether to let the server paginate internally |
| `vouchertype` | Tally voucher type filter — fetches Sales and Credit Notes |

**Retry Logic**:
- Max retries: **3** (configurable via `maxRetries` parameter)
- Backoff: **Exponential** — `1000ms * attemptNumber` (1s, 2s, 3s)
- On retry, the worker posts a `status: 'retry'` message to the UI
- If all retries fail, the download **stops** at that chunk and an error is posted

**Response Format** (from backend):
```json
{
    "vouchers": [
        {
            "masterid": "12345",
            "alterid": 67890,
            "vouchertypename": "Sales",
            "vouchertypereservedname": "Sales",
            "vouchernumber": "INV-001",
            "date": "01-Apr-25",
            "partyledgername": "Customer ABC",
            "amount": "10,00,000.00",
            "state": "Tamil Nadu",
            "country": "India",
            "salesperson": "John",
            "ledgerentries": [...],
            "allinventoryentries": [...]
        }
    ]
}
```

### 5.4 Date Parsing (`parseTallyDate()`)

Tally dates come in `DD-Mon-YY` format (e.g., `01-Apr-25`). The parser normalizes them to `YYYYMMDD`:

| Input | Output |
|---|---|
| `01-Apr-25` | `20250401` |
| `15-Dec-2024` | `20241215` |
| `20250401` (already normalized) | `20250401` (pass-through) |

### 5.5 Number Parsing (`stripCommas()`)

Tally uses Indian number formatting with commas (e.g., `10,00,000.00`). SQLite's `CAST(x AS REAL)` would truncate at the first comma, yielding `10` instead of `1000000`. The `stripCommas()` function removes all commas before storage:

```
"10,00,000.00" → "1000000.00"
```

This is applied to `amount` fields during both **insertion** and **aggregation SQL**.

### 5.6 Post-Download Steps

After all chunks are fetched and inserted:
1. **Sync metadata** is updated in the `sync_meta` table:
   - `last_sync_time` → Current ISO timestamp
   - `last_sync_guid` → The company GUID
   - `last_sync_from` → The start date of the download
   - `last_sync_to` → The end date of the download
2. **Aggregates are rebuilt** via `rebuildAggregates(guid)` (see Section 9)
3. **LRU query cache is cleared** since the underlying data has changed
4. A `download_complete` message is posted to the UI

### 5.7 Incremental Update Flow (`handleUpdate`)

Instead of re-downloading everything, the Update flow:
1. Reads `MAX(alterid)` from the existing `vouchers` table
2. Reads `last_sync_from` from `sync_meta` for the start date
3. Uses today's date as the end date
4. Fetches chunks with `lastaltid` set to the max alter ID — the backend only returns records with `alterid > lastaltid`
5. Same insert → aggregate → cache clear pipeline

---

## 6. Storage Layer — SQLite WASM on OPFS

### Database Initialization (`initDb()`)

```js
const sqlite3 = await sqlite3InitModule({...});
if (sqlite3.oo1.OpfsDb) {
    db = new sqlite3.oo1.OpfsDb('/sales_cache.db');
} else {
    db = new sqlite3.oo1.DB(':memory:');  // Fallback
}
```

**OPFS Path**: The database file is stored at `/sales_cache.db` in the browser's Origin Private File System. This is a sandboxed file system that:
- Is **persistent** across page reloads and browser restarts
- Is **scoped to the origin** (domain + port)
- Supports **synchronous I/O** from Web Workers

**Fallback**: If OPFS is not supported (e.g., older browsers, missing COOP/COEP headers), the database is created in-memory. Data will be **lost on page reload**.

### Migration System

The worker includes a migration check on startup:

```js
const AGG_VERSION = 2;  // Bump to force aggregate rebuild
const currentVersion = db.selectValue("SELECT value FROM sync_meta WHERE key='agg_version'");
if (!currentVersion || Number(currentVersion) < AGG_VERSION) {
    // Rebuild all aggregates for all companies
    for (const guid of guids) rebuildAggregates(guid);
    // Store new version
}
```

This ensures that when the aggregate SQL logic changes (e.g., the comma-stripping fix), all existing aggregate data is rebuilt automatically on the next page load.

---

## 7. Database Schema (Every Table, Column & Index)

### 7.1 `vouchers` — Fact Table (Transaction Headers)

| Column | Type | Description |
|---|---|---|
| `masterid` | TEXT | **PK (with guid)** — Unique transaction ID from Tally |
| `alterid` | INTEGER | Tally's internal modification counter (used for incremental sync) |
| `vouchertypename` | TEXT | Display name (e.g., "Sales", "Credit Note") |
| `vouchertypereservedname` | TEXT | System name (e.g., "Sales", "Credit Note") — used for sign logic |
| `vouchernumber` | TEXT | Human-readable voucher/invoice number |
| `date` | TEXT | Normalized to YYYYMMDD — **Indexed** |
| `partyledgername` | TEXT | Customer/party name — **Indexed** |
| `partyledgernameid` | TEXT | Customer/party ID |
| `state` | TEXT | State/region (e.g., "Tamil Nadu") |
| `country` | TEXT | Country name (e.g., "India") |
| `partygstin` | TEXT | Party's GST number |
| `pincode` | TEXT | Shipping/billing pincode |
| `address` | TEXT | Full address (JSON-stringified if an object) |
| `amount` | TEXT | Bill value (stored as text, commas stripped on insert) |
| `iscancelled` | TEXT | "Yes"/"No" — cancelled vouchers are excluded from all analytics |
| `isoptional` | TEXT | "Yes"/"No" |
| `guid` | TEXT | Company GUID — scopes all data — **Indexed** |
| `salesperson` | TEXT | Derived or explicit salesperson name |

**Primary Key**: `(masterid, guid)` — A record is uniquely identified by its Tally master ID within a company.

**Indexes**:
| Index Name | Columns | Purpose |
|---|---|---|
| `idx_vouchers_date` | `(date)` | Fast range scans for date-filtered queries |
| `idx_vouchers_guid` | `(guid)` | Company-scoped queries |
| `idx_vouchers_partyledgername` | `(partyledgername)` | Customer drill-down |
| `idx_vouchers_guid_cancel_date` | `(guid, iscancelled, date)` | Composite for filtered range scans |
| `idx_vouchers_analytics` | `(guid, iscancelled, date, state, partyledgername, amount)` | **Covering index** for common KPI queries — avoids table lookups entirely |

### 7.2 `ledger_entries` — Accounting Dimension

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | PK (auto-increment) |
| `voucher_masterid` | TEXT | FK → `vouchers.masterid` |
| `guid` | TEXT | Company GUID |
| `ledgername` | TEXT | Ledger/account name |
| `ledgernameid` | TEXT | Ledger ID |
| `amount` | TEXT | Ledger entry amount |
| `isdeemedpositive` | TEXT | Sign indicator |
| `ispartyledger` | TEXT | "Yes" if this is the party (customer) ledger |
| `groupname` | TEXT | Parent group name (e.g., "Sundry Debtors") — **Indexed** |
| `groupofgroup` | TEXT | Grandparent group |
| `grouplist` | TEXT | Full group hierarchy |
| `ledgergroupidentify` | TEXT | Alternative group identifier |

**Indexes**:
| Index | Columns | Purpose |
|---|---|---|
| `idx_le_voucher` | `(voucher_masterid, guid)` | Join to vouchers |
| `idx_le_groupname` | `(groupname)` | Chart: Sales by Ledger Group |
| `idx_le_ispartyledger` | `(ispartyledger)` | Finding the party ledger entry |
| `idx_le_voucher_group` | `(voucher_masterid, guid, ispartyledger, groupname)` | Composite for salesperson derivation |
| `idx_ledger_analytics` | `(voucher_masterid, groupname, amount)` | Covering index for aggregation queries |

### 7.3 `inventory_entries` — Item Dimension

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | PK (auto-increment) |
| `voucher_masterid` | TEXT | FK → `vouchers.masterid` |
| `guid` | TEXT | Company GUID |
| `stockitemname` | TEXT | Item name — **Indexed** |
| `stockitemnameid` | TEXT | Item ID |
| `uom` | TEXT | Unit of measurement |
| `actualqty` | TEXT | Actual delivery quantity |
| `billedqty` | TEXT | Billed quantity (primary for analytics) |
| `rate` | TEXT | Unit rate/price |
| `discount` | TEXT | Discount amount |
| `amount` | TEXT | Line item total amount |
| `stockitemgroup` | TEXT | Item category/group — **Indexed** |
| `stockitemgroupofgroup` | TEXT | Parent of item group |
| `stockitemgrouplist` | TEXT | Full group hierarchy |
| `grosscost` | TEXT | Gross cost |
| `grossexpense` | TEXT | Gross expense |
| `profit` | TEXT | Profit for this line item |

**Indexes**:
| Index | Columns | Purpose |
|---|---|---|
| `idx_ie_voucher` | `(voucher_masterid, guid)` | Join to vouchers |
| `idx_ie_stockitemname` | `(stockitemname)` | Item filter queries |
| `idx_ie_stockitemgroup` | `(stockitemgroup)` | Chart: Sales by Stock Group |
| `idx_ie_voucher_stock` | `(voucher_masterid, guid, stockitemname)` | Composite for item drill-down |
| `idx_inventory_analytics` | `(voucher_masterid, stockitemgroup, stockitemname, amount, profit)` | **Covering index** for aggregation |

### 7.4 `sync_meta` — Synchronization State

| Key | Value | Description |
|---|---|---|
| `last_sync_time` | ISO timestamp | When the last sync completed |
| `last_sync_guid` | Company GUID | Which company was last synced |
| `last_sync_from` | YYYYMMDD | Start date of last download |
| `last_sync_to` | YYYYMMDD | End date of last download |
| `agg_version` | Integer | Version of the aggregation logic (for forced rebuilds) |

### 7.5 `agg_daily_stats` — Pre-Aggregated Daily KPIs

| Column | Type | Description |
|---|---|---|
| `date` | TEXT | Date (YYYYMMDD) |
| `guid` | TEXT | Company GUID |
| `total_sales` | REAL | Sum of sales for this day (Credit Notes negated) |
| `total_txns` | INTEGER | Count of transactions for this day |
| `max_sale` | REAL | Maximum single sale amount for this day |

**Primary Key**: `(guid, date)` — One row per day per company.

**Purpose**: Instead of scanning 100K+ raw vouchers, KPI queries scan this table which typically has ~365 rows per year. This is the **biggest performance win** in the entire system.

### 7.6 `agg_charts` — Pre-Aggregated Chart Data

| Column | Type | Description |
|---|---|---|
| `guid` | TEXT | Company GUID |
| `date` | TEXT | Date (YYYYMMDD) |
| `dim_type` | TEXT | Dimension type: `'stock_group'`, `'ledger_group'`, `'country'`, `'salesperson'`, `'item'` |
| `dim_name` | TEXT | Dimension value (e.g., "Electronics", "Tamil Nadu") |
| `amount` | REAL | Aggregated sales amount |
| `profit` | REAL | Aggregated profit (only for `dim_type='item'`) |
| `qty` | REAL | Aggregated quantity (only for `dim_type='item'`) |

**Index**: `idx_agg_charts_main` on `(guid, dim_type, date)` — Enables fast range scans per dimension type.

**Purpose**: Avoids expensive JOINs between `vouchers` ↔ `inventory_entries` / `ledger_entries` at query time. All chart data can be computed from simple `SUM + GROUP BY` on this single table.

---

## 8. Data Insertion Engine

### How `insertVouchers()` Works (Step by Step)

1. **Three Prepared Statements** are created once before the loop:
   - `stmtV` — Insert into `vouchers` (18 bind parameters)
   - `stmtL` — Insert into `ledger_entries` (11 bind parameters)
   - `stmtI` — Insert into `inventory_entries` (16 bind parameters)

2. **Transaction wrapping**: The entire batch is wrapped in `BEGIN TRANSACTION` / `COMMIT`. If any error occurs, `ROLLBACK` is called.

3. **Per-voucher logic** (for each voucher in the batch):
   - **Delete existing entries**: Removes any existing `ledger_entries` and `inventory_entries` for this `masterid + guid` to prevent ghost records during updates
   - **Date normalization**: Converts Tally date format (e.g., `01-Apr-25`) to `YYYYMMDD`
   - **Salesperson derivation**: 
     1. First checks explicit fields: `salesperson`, `SalesPerson`, `salesprsn`, `SalesPrsn`, `salespersonname`
     2. If empty, looks at `ledgerentries[]` to find the party ledger entry (where `ispartyledger === 'Yes'` and `ledgername === partyledgername`)
     3. Uses the party ledger's `groupname` or `parent` as the salesperson
   - **Amount stripping**: Commas are removed from `amount` fields via `stripCommas()`
   - **Value safety**: The `s()` helper ensures `null`, `undefined`, and objects are safely converted to strings. The `n()` helper safely parses integers with a fallback of `0`
   - **Bind + Step + Reset**: Parameters are bound, the statement is stepped (executed), and reset for the next iteration

4. **`INSERT OR REPLACE`** on `vouchers` ensures idempotency — re-syncing the same date range won't create duplicates.

5. **Finalization**: All three prepared statements are finalized in the `finally` block to free resources.

**Performance**: Prepared statements are **parsed once** by SQLite and **executed thousands of times** — this avoids SQL compilation overhead on every row. Combined with the transaction batch, this can insert thousands of records per second.

---

## 9. Pre-Aggregation Engine

### When It Runs

`rebuildAggregates(guid)` runs:
- After every **Download** completes
- After every **Update** completes
- On **startup** if `agg_version` in `sync_meta` doesn't match the code's `AGG_VERSION` constant
- As a **self-healing** fallback if a query detects missing aggregates

### What It Does (Step by Step)

All operations are wrapped in a single transaction for atomicity.

#### Step 1: Rebuild `agg_daily_stats`

```sql
DELETE FROM agg_daily_stats WHERE guid='<guid>';
INSERT INTO agg_daily_stats (date, guid, total_sales, total_txns, max_sale)
SELECT 
  date, '<guid>', 
  SUM(CASE WHEN vouchertypereservedname LIKE '%Credit Note%' 
      THEN -CAST(REPLACE(amount, ',', '') AS REAL) 
      ELSE CAST(REPLACE(amount, ',', '') AS REAL) END),
  COUNT(*),
  MAX(CASE WHEN vouchertypereservedname NOT LIKE '%Credit Note%' 
      THEN CAST(REPLACE(amount, ',', '') AS REAL) ELSE 0 END)
FROM vouchers 
WHERE guid='<guid>' AND iscancelled='No'
GROUP BY date
```

**Credit Note handling**: Credit Notes are **negated** (`-amount`) in the sales total but excluded from `max_sale`. This ensures returns/refunds reduce the total revenue correctly.

#### Step 2: Create Temporary Working Table `_v_agg`

```sql
CREATE TEMP TABLE _v_agg AS 
SELECT masterid, 
       CASE WHEN vouchertypereservedname LIKE '%Credit Note%' THEN -1 ELSE 1 END as sign,
       country, salesperson, amount, date
FROM vouchers 
WHERE guid='<guid>' AND iscancelled='No'
```

This temp table materializes the voucher data with the sign logic pre-computed, so downstream queries don't need to repeat the `CASE WHEN` logic.

#### Step 3: Build `agg_charts` by Dimension

Five separate INSERT statements populate `agg_charts` for each dimension:

| `dim_type` | Source | GROUP BY | Columns Aggregated |
|---|---|---|---|
| `stock_group` | `inventory_entries` JOIN `_v_agg` | `date, stockitemgroup` | `amount` |
| `ledger_group` | `ledger_entries` JOIN `_v_agg` | `date, groupname` | `amount` |
| `country` | `_v_agg` | `date, country` | `amount` |
| `salesperson` | `_v_agg` | `date, salesperson` | `amount` |
| `item` | `inventory_entries` JOIN `_v_agg` | `date, stockitemname` | `amount`, `qty`, `profit` |

#### Step 4: Cleanup

The temporary `_v_agg` table is dropped and the transaction is committed.

---

## 10. Query Engine — Dual-Path Architecture

This is the heart of the dashboard's performance. `getDashboardData()` uses **two completely different query strategies** depending on the active filters.

### 10.1 Fast Path (No Complex Filters)

**Condition**: No `stockGroup`, `stockItem`, or `ledgerGroup` filters AND no dimension filters (state, country, customer, salesperson, period).

**What it does**:
1. **KPIs** are read from `agg_daily_stats` — a simple range scan on ~365 rows:
   ```sql
   SELECT SUM(total_sales), SUM(total_txns), MAX(max_sale)
   FROM agg_daily_stats 
   WHERE guid=? AND date>=? AND date<=?
   ```
2. **Sales Trend** is read from `agg_daily_stats` directly (already daily granularity)
3. **Sales by State** and **Top Customers** are computed from `vouchers` with index scans (the covering index `idx_vouchers_analytics` makes this fast)
4. **Top Items** are read from `agg_charts` (pre-aggregated, avoids the expensive JOIN):
   ```sql
   SELECT dim_name as name, SUM(amount) as value 
   FROM agg_charts 
   WHERE guid=? AND dim_type='item' AND date>=? AND date<=?
   GROUP BY dim_name ORDER BY value DESC LIMIT 10
   ```

**Result**: KPIs render in **<50ms**, charts in **<100ms**, even with 100K+ vouchers.

### 10.2 Slow Path (Complex Filters Active)

**Condition**: Any item-level filter (`stockGroup`, `stockItem`, `ledgerGroup`) OR any dimension filter is active.

**What it does**:

1. **Build dynamic WHERE clauses** from the active filters:
   ```sql
   -- Item filters use subqueries:
   AND masterid IN (SELECT voucher_masterid FROM inventory_entries WHERE stockitemgroup='Electronics')
   -- Dimension filters are direct:
   AND state='Tamil Nadu'
   AND salesperson='John'
   AND SUBSTR(date,1,6)='202504'   -- Period filter
   ```

2. **Materialize a Temp Table** (`_fv`) containing only matching vouchers:
   ```sql
   CREATE TEMP TABLE _fv AS
   SELECT masterid, date, partyledgername, state, country, amount,
          vouchertypereservedname, salesperson,
          CASE WHEN vouchertypereservedname LIKE '%Credit Note%' THEN 1 ELSE 0 END AS is_cn,
          CAST(REPLACE(amount, ',', '') AS REAL) AS amt
   FROM vouchers
   WHERE guid=? AND iscancelled='No' AND date>=? AND date<=? <filterClauses>
   ```

3. **Index the temp table**: `CREATE INDEX _fv_mid ON _fv(masterid)` — essential for fast JOINs.

4. **KPI Precision Logic**: If item-level filters are active, the total revenue is computed from `inventory_entries` (line item amounts) instead of `vouchers` (bill amounts):
   ```sql
   -- With item filter: Sum matching line items, not the total bill
   SELECT SUM(CASE WHEN f.is_cn THEN -i.amount ELSE i.amount END)
   FROM inventory_entries i JOIN _fv f ON i.voucher_masterid = f.masterid
   WHERE i.stockitemgroup='Electronics'
   
   -- Without item filter: Sum the voucher bill values
   SELECT SUM(CASE WHEN is_cn THEN -amt ELSE amt END) FROM _fv
   ```
   
   **Why this matters**: If a bill has items A (₹5000), B (₹3000), and C (₹2000), and the user filters by item A, the total should be ₹5000, not ₹10000 (the bill total).

5. **Charts** are computed against `_fv` using JOINs where needed.

6. **Cleanup**: `DROP TABLE IF EXISTS _fv`

---

## 11. Extended Dashboard Data

### `getExtendedDashboardData_Direct()` — Fast Path Extended Data

When no complex filters are active, extended chart data is read directly from pre-aggregated tables:

| Chart | Source Table | Query Pattern |
|---|---|---|
| Sales by Stock Group | `agg_charts` (`dim_type='stock_group'`) | `SUM(amount) GROUP BY dim_name` |
| Sales by Ledger Group | `agg_charts` (`dim_type='ledger_group'`) | `SUM(amount) GROUP BY dim_name` |
| Sales by Country | `agg_charts` (`dim_type='country'`) | `SUM(amount) GROUP BY dim_name` |
| Sales by Salesperson | `agg_charts` (`dim_type='salesperson'`) | `SUM(amount) GROUP BY dim_name` |
| Top Items by Quantity | `agg_charts` (`dim_type='item'`) | `SUM(qty) GROUP BY dim_name` |
| Top Profitable Items | `agg_charts` (`dim_type='item'`) | `SUM(profit) GROUP BY dim_name DESC` |
| Top Loss Items | `agg_charts` (`dim_type='item'`) | `SUM(profit) GROUP BY dim_name ASC` |
| Sales by Period | `agg_daily_stats` | `SUM(total_sales) GROUP BY SUBSTR(date,1,6)` |
| Month-wise Profit | `agg_charts` (`dim_type='item'`) | `SUM(profit) GROUP BY SUBSTR(date,1,6)` |

**Self-Healing**: If `agg_charts` is empty (e.g., after a migration issue), the function automatically calls `rebuildAggregates()` before querying.

### `getExtendedDashboardData()` — Slow Path Extended Data

When filters are active, all extended data is computed against the `_fv` temp table with JOINs to `inventory_entries` and `ledger_entries`.

---

## 12. Dynamic Card Engine

The dashboard supports **custom cards** defined via a backend API configuration. Each custom card is a JSON object that describes what data to show.

### Card Configuration Format

```json
{
    "id": "card-123",
    "title": "Revenue by Region by Quarter",
    "chartType": "bar",
    "groupBy": "state",
    "valueField": "amount",
    "aggregation": "sum",
    "topN": 10,
    "isActive": true,
    "cardConfig": {
        "segmentBy": "quarter",
        "enableStacking": true,
        "multiAxisSeries": [...]
    },
    "filters": [
        { "filterField": "allinventoryentries.stockitemgroup", "filterValues": ["Electronics"] }
    ]
}
```

### Resolution Pipeline

#### `resolveGroupBy(groupBy)`

Maps abstract groupBy names to SQL expressions:

| `groupBy` Value | SQL Expression | Table |
|---|---|---|
| `'month'` | `SUBSTR(v.date, 1, 6)` | `v` |
| `'quarter'` | `SUBSTR(v.date,1,4)\|\|'-Q'\|\|((CAST(SUBSTR(v.date,5,2) AS INTEGER)-1)/3+1)` | `v` |
| `'date'` | `v.date` | `v` |
| `'week'` | Complex week number expression | `v` |
| `'item'` | `i.stockitemname` | `i` |
| `'customer'` | `v.partyledgername` | `v` |
| `'state'` | `v.state` | `v` |
| `'country'` | `COALESCE(NULLIF(v.country,''),'Unknown')` | `v` |
| `'allinventoryentries.stockitemgroup'` | `i.stockitemgroup` | `i` |
| `'ledgerentries.group'` | `l.groupname` | `l` |

#### `resolveValue(valueField, aggregation)`

Maps abstract value fields to SQL aggregation expressions:

| `valueField` | `aggregation` | SQL Expression |
|---|---|---|
| `'amount'` | `'sum'` | `SUM(CASE WHEN Credit Note THEN -amount ELSE amount END)` |
| `'profit'` | `'sum'` | `SUM(CASE WHEN Credit Note THEN -profit ELSE profit END)` |
| `'transactions'` | `'count'` | `COUNT(DISTINCT v.masterid)` |
| `'unique_customers'` | `'count'` | `COUNT(DISTINCT v.partyledgername)` |

#### `buildJoins(needsInventory, needsLedger)`

Automatically determines which tables need to be JOINed based on the groupBy and valueField:

```sql
-- If groupBy='item' or valueField='profit':
JOIN inventory_entries i ON i.voucher_masterid = v.masterid AND i.guid = v.guid

-- If groupBy='ledgerentries.group':
JOIN ledger_entries l ON l.voucher_masterid = v.masterid AND l.guid = v.guid
```

### Segmented (Stacked) Charts

When `cardConfig.segmentBy` is set, the data is pivoted into a format suitable for stacked bar/line charts:

1. First query: Get top N groups with their totals
2. Second query: Get all group × segment combinations
3. **Segment limiting**: Only the top 5 segments by total value are kept; the rest are collapsed into "Other"
4. **Pivot**: Flat SQL rows are transformed into nested objects:

```json
// SQL output:
// { name: "Jan", segment: "Electronics", value: 1000 }
// { name: "Jan", segment: "Furniture",   value: 500  }

// Pivoted output:
// { name: "Jan", "Electronics": 1000, "Furniture": 500 }
```

### Multi-Axis Charts

For cards with `chartType: 'multiAxis'` and `cardConfig.multiAxisSeries`, each series is resolved into a separate SQL `SELECT` column:

```sql
SELECT SUBSTR(v.date,1,6) as name,
       SUM(amount) as "Revenue",
       COUNT(DISTINCT v.masterid) as "Transactions"
FROM vouchers v ...
GROUP BY SUBSTR(v.date,1,6)
```

The `seriesInfo` metadata tells the UI which axis and chart type (bar vs line) to use for each series.

---

## 13. LRU Result Cache

The Worker maintains an **in-memory LRU (Least Recently Used) cache** to avoid re-running identical queries:

```
Max Size: 20 entries
Key:      "{guid}:{fromDate}:{toDate}:{JSON.stringify(filters)}"
Value:    The full dashboard data response (kpi + charts + extended + cards)
```

**Get**: On cache hit, the entry is moved to the end of the Map (most recently used).
**Set**: If the cache exceeds 20 entries, the oldest entry (first key in the Map) is evicted.
**Clear**: The cache is cleared after any download, update, or clear operation.

**Impact**: When a user switches back to a previously-viewed date range, the response is **instant** (0ms query time).

---

## 14. Worker ↔ UI Message Protocol

All communication between the Main Thread and the Web Worker uses `postMessage()` / `onmessage`.

### Messages from UI → Worker

| `type` | `payload` | Description |
|---|---|---|
| `init` | — | Initialize SQLite, create schema |
| `download` | `{ tallyloc_id, company, guid, fromdate, todate, token }` | Full download |
| `update` | `{ tallyloc_id, company, guid, token }` | Incremental update |
| `get_stats` | `{ guid }` | Get record counts and sync metadata |
| `clear` | `{ guid }` | Delete all data for a company |
| `get_all_dashboard_data` | `{ guid, fromDate, toDate, filters, cards[] }` | Combined KPIs + charts + extended + custom cards |
| `get_raw_data` | `{ guid, limit, offset }` | Paginated raw voucher data for JSON inspector |

### Messages from Worker → UI

| `type` | Data | Description |
|---|---|---|
| `ready` | — | SQLite initialized, schema created |
| `progress` | `{ current, total, message }` | Download/update progress |
| `status` | `{ status, message }` | Status change (downloading, updating, retry) |
| `stats` | `{ stats: {...} }` | Record counts and metadata |
| `all_dashboard_data` | `{ data: { kpi, charts, extended }, cardsData }` | Complete dashboard payload |
| `raw_data` | `{ data: { totalVouchers, showing, vouchers[] } }` | Paginated raw data |
| `download_complete` | `{ totalRecords, message }` | Download finished |
| `update_complete` | `{ totalRecords, message }` | Update finished |
| `clear_complete` | `{ message }` | Cache cleared |
| `error` | `{ message }` | Error occurred |

---

## 15. useWorker Hook — The Bridge

`useWorker()` is a custom React hook that manages the Worker lifecycle:

```
┌─────────────────────────────────────────┐
│              useWorker()                 │
│                                         │
│  State:                                 │
│  ├── isReady       (bool)               │
│  ├── status        (string)             │
│  ├── progress      ({current,total,msg})│
│  ├── stats         (object)             │
│  ├── dashboardData (object)             │
│  ├── customCardsData (object)           │
│  ├── rawData       (object)             │
│  ├── error         (string)             │
│  └── lastMessage   (object)             │
│                                         │
│  Methods:                               │
│  └── sendMessage(type, payload)         │
│                                         │
│  Internal:                              │
│  └── Progress debounce (100ms)          │
└─────────────────────────────────────────┘
```

### Progress Debouncing

During downloads, the Worker emits `progress` events for every chunk (potentially hundreds per second). To prevent React from re-rendering on every event:

```js
const PROGRESS_DEBOUNCE_MS = 100;
// ...
case 'progress':
    pendingProgress = { current, total, message };
    if (!progressTimer) {
        progressTimer = setTimeout(() => {
            setProgress(pendingProgress);
            progressTimer = null;
        }, PROGRESS_DEBOUNCE_MS);
    }
    break;
```

This batches rapid progress updates into at most 10 updates per second.

---

## 16. Dashboard Page — Rendering Architecture

### Component Hierarchy

```
Dashboard
├── KpiCards (React.memo)
│   └── KpiCard (React.memo) × 4
│       [Total Revenue, Total Transactions, Avg Order Value, Max Single Sale]
├── SalesTrendChart (React.memo)
│   └── Recharts AreaChart (daily trend)
├── BuiltInCharts (React.memo)
│   └── ChartWidget (lazy-loaded) × 13
│       [Stock Group, Ledger Group, State, Country, Monthly Sales,
│        Profit Trend, Revenue vs Profit, Top Customers, Top Items Revenue,
│        Top Items Qty, Salesperson, Profitable Items, Loss Items]
└── DynamicCard (React.memo) × N
    └── ChartWidget OR MultiAxisChart (lazy-loaded)
```

### Data Flow

1. **On mount**: Company is read from `localStorage`, card configurations are fetched from the API
2. **When ready**: A single `get_all_dashboard_data` message is sent to the Worker with the current date range, filters, and card configs
3. **Worker responds**: `dashboardData` state is set, which triggers a re-render showing KPIs and charts
4. **Filter interaction**: Clicking a chart bar adds a filter pill and re-sends the `get_all_dashboard_data` message with the updated filters

### Date Optimization

- **Debounced dates**: When typing in the date inputs, state updates are debounced by 400ms to avoid spamming the Worker
- **Immediate on blur/Enter**: Dates apply immediately when the user tabs away or presses Enter
- **Presets**: MTD (Month to Date), QTD (Quarter to Date), FYTD (Financial Year to Date) apply instantly with no debounce

### Memoization Strategy

Every sub-component is wrapped in `React.memo()` to prevent unnecessary re-renders:
- `KpiCards` only re-renders if `kpi` object reference changes
- `SalesTrendChart` only re-renders if `data` array reference changes
- `BuiltInCharts` only re-renders if `ext`, `charts`, `activeFilters`, or `isLoading` change
- `DynamicCard` only re-renders if `card` or `customCardsData` change

Chart components (`ChartWidget`, `MultiAxisChart`) are **lazy-loaded** via `React.lazy()` to reduce the initial bundle size.

### Currency Formatting

```js
const currencyFmt = new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});
```

A single `Intl.NumberFormat` instance is created outside the component to avoid recreation on every render. Example: `₹12,50,000`.

---

## 17. Cache Management Page

The Cache Management page provides a control panel for the data pipeline:

### Actions

| Action | Worker Message | Description |
|---|---|---|
| **Download** | `download` | Full sync for a user-selected date range |
| **Update** | `update` | Incremental sync using `MAX(alterid)` as cursor |
| **Clear Cache** | `clear` | Deletes all data for the company (with confirmation dialog) |
| **View Cards** | — (API call) | Shows the custom card configurations from the API |
| **View JSON** | `get_raw_data` | Paginated raw voucher inspector (50 per page) |

### Statistics Display

The page shows:
- **Record counts**: Vouchers, Ledger Entries, Inventory Entries
- **Date range**: MIN/MAX date in the database
- **Estimated size**: Rough calculation of `(totalRows × 1KB)`
- **Last sync time**: Relative time display (e.g., "5m ago", "Yesterday")
- **Max Alter ID**: The cursor position for incremental updates
- **Dashboard cards**: Count of active custom cards from the API

---

## 18. Performance Optimization Summary

| Technique | Where | Impact |
|---|---|---|
| **Pre-aggregated daily stats** | `agg_daily_stats` table | KPIs scan ~365 rows instead of 100K+ |
| **Pre-aggregated chart data** | `agg_charts` table | Avoids expensive JOINs at query time |
| **Covering indexes** | `idx_vouchers_analytics`, `idx_inventory_analytics` | SQLite reads data from the index without touching the table |
| **Dual-path query engine** | `getDashboardData()` | Unfiltered queries use fast aggregated path; filtered queries fall back to temp table |
| **Prepared statements** | `insertVouchers()` | SQL parsed once, executed thousands of times |
| **Transaction batching** | All insert/aggregate operations | Reduces fsync calls from N to 1 |
| **LRU result cache** | In-worker memory (20 entries) | Repeated queries return instantly |
| **Web Worker threading** | All DB operations | UI never freezes during queries or downloads |
| **Progress debouncing** | `useWorker.js` (100ms) | Max 10 React re-renders/sec during downloads |
| **React.memo** | All UI components | Prevents unnecessary re-renders |
| **Lazy loading** | `ChartWidget`, `MultiAxisChart` | Charts loaded on demand, not at startup |
| **Manual chunk splitting** | Vite config (`recharts`) | Recharts loaded separately, doesn't block initial render |
| **COOP/COEP headers** | Vite + Netlify config | Enables OPFS for persistent storage |
| **Comma stripping in SQL** | `REPLACE(amount, ',', '')` | Handles Tally's Indian number format without data transformation |
| **Self-healing aggregates** | `getExtendedDashboardData_Direct()` | Auto-rebuilds if aggregates are missing |
| **Exponential backoff retries** | `fetchChunkWithRetry()` | Resilience against transient network failures |
