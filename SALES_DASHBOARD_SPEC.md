## Sales Dashboard – Functional & Data Specification

This document describes the **Sales Dashboard** in a backend‑agnostic way so it can be implemented in other platforms (for example, an Android app) while staying functionally equivalent to the existing web dashboard.

---

### 1. High‑Level Flow

- **Company selection**
  - User selects one or more companies from a multi‑company list.
  - Selected company list is persisted locally (e.g., local storage / shared preferences).

- **Cache‑only data loading**
  - When the Sales Dashboard tab opens:
    - It checks if a **complete sales cache** exists for the selected company/companies.
    - If no cache exists, dashboard waits for the user to trigger a **Refresh / Download** action.
    - If cache exists, it **loads sales vouchers from cache** and applies the default date range.
  - Cache download / sync is orchestrated by a background “cache sync manager” which:
    - Knows which company is active.
    - Exposes **progress**: `current`, `total`, `percentage`, `message`.
    - Supports **resume** of interrupted downloads.

- **User triggers cache refresh**
  - User taps a **Refresh/Sync** button.
  - A long‑running background task:
    - Authenticates (using stored token).
    - Calls a Tally data endpoint (or equivalent) to fetch vouchers.
    - Writes the vouchers into a **complete sales cache** (OPFS / local DB / file).
    - Updates progress and completion timestamp.

- **Dashboard rendering**
  - UI reads vouchers from the **complete cache** based on:
    - Global filters (dates, customer, item, stock group, ledger group, region, country, pincode, salesperson).
    - Optional **per‑card date overrides** (card‑specific periods).
  - From the filtered dataset(s) the dashboard computes:
    - **Key metrics (KPI cards)**.
    - **Aggregated datasets** for all charts.
  - User interactions (e.g., selecting region, customer) update filters and recompute the same derived datasets.

---

### 2. Sales Cache – Core Data Model

The sales cache is a collection of **voucher objects**. The exact field names may vary by source, so the system uses case‑insensitive access and configurable field paths.

- **Top‑level voucher fields (canonical names used by the dashboard)**

  **Core transaction fields:**
  - `amount` – numeric; net sales amount for the voucher (item-level, aggregated per inventory entry).
  - `quantity` – numeric; total quantity sold (from `billedqty`, `qty`, or `actualqty`).
  - `date` / `cp_date` – date string in `YYYY-MM-DD` format (or convertible to this).
  - `masterid` / `mstid` – unique identifier per voucher (used to count invoices/orders).
  - `vchno` / `vouchernumber` – voucher number/reference.
  - `alterid` – alternate ID for the voucher.
  - `vchtype` / `vouchertypename` – voucher type name.
  - `issales` – boolean flag indicating if this is a sales transaction.

  **Party/Customer fields:**
  - `customer` / `partyledgername` / `party` – customer / party name.
  - `partyid` / `partyledgernameid` – customer/party ID.
  - `gstno` / `partygstin` / `gstin` – GST number of the party.

  **Item/Product fields:**
  - `item` / `stockitemname` – item / stock item name.
  - `itemid` / `stockitemnameid` – item ID.
  - `category` / `stockitemcategory` – stock group / category.
  - `uom` – unit of measurement.
  - `grosscost` – gross cost amount (item-level).
  - `grosexpense` / `grossexpense` – gross expense amount (item-level).

  **Financial fields:**
  - `profit` – numeric profit amount for the voucher (item-level, if not directly present, can be derived).
  - `cgst` – CGST amount (proportionally distributed per item).
  - `sgst` – SGST amount (proportionally distributed per item).
  - `roundoff` – round-off amount (proportionally distributed per item).

  **Organizational fields:**
  - `ledgerGroup` – ledger group name (e.g., Debtors, Dealers), extracted from `ledgerentries` or `accalloc`.
  - `region` / `state` – state / region code (e.g., `TN`, `KA`).
  - `country` – country name (e.g., `India`).
  - `pincode` – shipping/billing pincode where available.
  - `salesperson` / `salesprsn` / `SalesPrsn` / `salespersonname` – salesperson name/identifier (may be computed from a formula).

  **Reference fields:**
  - `reference` – reference number or note.

  **Multi-company fields (when merging data from multiple companies):**
  - `sourceCompany` – source company name.
  - `sourceCompanyGuid` – source company GUID.
  - `sourceCompanyTallylocId` – source company Tally location ID.

  **Field name variations:**
  - The system supports multiple field name variations (e.g., `party` vs `partyledgername`, `item` vs `stockitemname`).
  - Case-insensitive matching is used for field access.
  - Original field names are preserved as `*_original` variants (e.g., `cp_date_original`, `customer_original`) for compatibility.

- **Additional nested fields**
  - Vouchers can contain nested arrays and objects. The main nested structures are:
    - `ledgerentries[]` – array of ledger entry objects (contains party information, allocations).
    - `billallocations[]` – array of bill allocation objects (within ledger entries).
    - `allinventoryentries[]` / `inventry[]` – array of inventory entry objects (items in the voucher).
    - `accalloc[]` – account allocation (within inventory entries, contains ledger group info).
    - `batchallocation[]` – batch allocation objects.
    - `accountingallocation[]` – accounting allocation objects.
    - `address` – address object (may contain nested address fields).
  - A **field extractor utility**:
    - Inspects a sample of vouchers (typically first 10 records).
    - Recursively traverses nested structures up to a maximum depth (default: 5 levels).
    - Builds a list of all possible field paths (e.g., `ledgerentries.billallocations.billname`, `allinventoryentries.accalloc.ledgergroupidentify`).
    - Groups fields by hierarchy level: `Voucher Fields`, `Ledger Entries`, `Bill Allocations`, `Inventory Entries`, `Batch Allocations`, `Accounting Allocations`, `Address`.
    - Exposes `getNestedFieldValue(obj, "path.to.field")` to read fields in a case‑ and structure‑tolerant way.
    - Handles arrays by returning the first value found when traversing nested paths.
  - This allows **UDF‑driven** custom KPIs or charts without changing the core model.
  - All fields from the original voucher are preserved in the sale record (except internal/metadata fields starting with `_` or `$`).

- **Data transformation (voucher → sale record)**
  - Each voucher in the cache is transformed into one or more **sale records** (at the item/inventory entry level).
  - If a voucher contains multiple inventory items (`allinventoryentries`), it produces multiple sale records (one per item).
  - Each sale record inherits:
    - Voucher-level fields (date, customer, region, country, etc.) – same for all items from the same voucher.
    - Item-level fields (item, quantity, amount, profit, etc.) – specific to each inventory entry.
    - Tax amounts (CGST, SGST, roundoff) are proportionally distributed per item based on item amount vs total voucher amount.
  - This transformation allows the dashboard to analyze sales at the **item level** while preserving voucher context.

- **Cache wrapper shape**
  - The complete cache is stored as:
    - `data.vouchers: Voucher[]` – full list of raw voucher records (nested structure).
    - `cacheTimestamp: string` – ISO timestamp of latest update.
  - On load for a date range:
    - Cache is not refetched; instead, vouchers are **filtered by date** from this complete list.
    - Filtered vouchers are then transformed into sale records (as described above).
    - The transformed sale records (`sales` array) are what the dashboard uses for all calculations and visualizations.

---

### 3. Global Filters & State

These filters define the base dataset (`filteredSales`) used by KPIs and charts (unless overridden per card):

- **Date filters**
  - Global `fromDate`, `toDate` (string `YYYY-MM-DD`).
  - `dateRange: { start, end }` – normalized version of the above.
  - **Period selector** supports:
    - Financial year, quarter, month, week, today, yesterday, custom range.
  - There is an `isSingleDayFromPeriodSelection` flag to know when a single date came from a period picker (affects how filters are shown).

- **Entity filters**
  - `selectedCustomer: "all" | string` – customer/party filter.
  - `selectedItem: "all" | string` – item filter.
  - `selectedStockGroup: "all" | string` – stock group/category filter.
  - `selectedLedgerGroup: "all" | string` – ledger group filter.
  - `selectedRegion: "all" | string` – state/region filter.
  - `selectedCountry: "all" | string`.
  - `selectedPincode: null | string` – optional drill‑down pincode filter.

- **Period aggregation filter**
  - `selectedPeriod: null | "YYYY-MM"` – used for period‑based views.

- **Salesperson filters**
  - `selectedSalesperson: null | string`.
  - `enabledSalespersons: Set<string>` – which salespersons are included in calculations.
  - `salespersonFormula: string` – expression defining how salesperson is derived from voucher fields or UDFs.

- **Generic filters for custom cards**
  - `genericFilters: { [fieldKey: string]: any }` – user‑defined filters for UDF‑backed or custom cards.

These filters are applied to the sales cache to produce:

- `filteredSales` – base dataset for revenue/quantity/customer‑related metrics and most charts.
- `filteredSalesForOrders` – similar but with an additional “is sales order” condition (used for counting invoices/orders).

---

### 4. Key Metrics (KPI Cards)

The dashboard exposes the following **core KPIs**, each rendered as a KPI card (`KPICard` equivalent):

- **Total Revenue**
  - **Formula**: sum of `amount` over `filteredSales`.
  - **Unit**: currency.
  - **Trend**: daily revenue curve over the selected date range.

- **Total Invoices**
  - **Formula**: count of distinct `masterid` in `filteredSalesForOrders`.
  - **Unit**: count.
  - **Trend**: daily invoice count curve.

- **Total Quantity**
  - **Formula**: sum of `quantity` over `filteredSales`.
  - **Unit**: units.

- **Unique Customers**
  - **Formula**: count of distinct `customer` values in `filteredSales` (case‑insensitive).
  - **Trend**: cumulative unique customer count per day.

- **Avg Invoice Value**
  - **Formula**: `Total Revenue / Total Invoices` (from the same filtered sets).
  - **Unit**: currency.
  - **Trend**: daily average invoice value.

- **Total Profit** (optionally visible)
  - **Formula**: sum of `profit` over `filteredSales`.
  - **Unit**: currency.

- **Profit Margin** (optionally visible)
  - **Formula**: `(Total Profit / Total Revenue) * 100`.
  - **Unit**: percentage.

- **Avg Profit per Order** (optionally visible)
  - **Formula**: `Total Profit / Total Invoices`.
  - **Unit**: currency.

**Visibility and configuration**

- KPI visibility can be controlled by:
  - **Backend permissions** (module/permission matrix, e.g. `sales_dashboard` permissions).
  - **Local user configuration** (toggle profit KPIs on/off).
- Profit KPIs are hidden by default and can be turned on via a `profitKpiVisibility` map:
  - `{"Total Profit": boolean, "Profit Margin": boolean, "Avg Profit per Order": boolean}`.

**KPI card visual behaviour**

- Each KPI card is rendered using a generic KPI card component (equivalent of `KPICard`) and supports:
  - **Title:** `title` – display name of the KPI (e.g., `Total Revenue`).
  - **Value:** `value` – numeric value (already aggregated in the domain layer).
  - **Target:** `target` – optional target value to compare against.
  - **Period label:** `period` – optional label/description of the current period (e.g., `This Month`).
  - **Status:** `status` – `'met' | 'below' | 'above'` (controls color/intent; defaults to `'met'` if not specified).
  - **Additional data:** `additionalData` – optional secondary number/text shown below the main value.
  - **Trend data:** `trendData: number[]` – daily (or periodic) values used to render the background sparkline/area chart.
  - **Formatter:** `format(value)` – function used to format the numeric value (e.g., applying number format, currency symbol).
  - **Unit:** `unit` – string appended to the value (e.g., `%`, currency symbol if not handled by `format`).
  - **Mobile flag:** `isMobile` – boolean that adjusts padding, width and font sizes for smaller screens.
  - **Icon config:** `iconName`, `iconBgColor`, `iconColor` – optional icon glyph and its colors shown on the card.

These properties are **visual configuration parameters**; the actual numbers (totals, averages, trends) are computed from the sales cache as described in the metric formulas above.

---

### 5. Chart Cards & Aggregations

All chart cards share this pattern:

- Input dataset: `getCardDataSource(cardName)` which:
  - Starts from `filteredSales` (or `allCachedSales` if per‑card date override is configured).
  - Applies the card’s specific **period override** if present.
- Aggregation:
  - Group by a “label” key (e.g., region, customer, item).
  - Sum over a numeric metric, usually `amount` (revenue) or `quantity`.
- Output format (for each chart point):
  - `{ label: string, value: number, [extraMetrics...] }`.

#### 5.1 Category / Stock Group

- **Card name**: `Sales by Stock Group`.
- **Grouping key**: `category` (stock group).
- **Metric**: sum of `amount`.
- **Charts supported**:
  - Bar chart, pie chart, line chart (switchable by user).
- **Parameters**:
  - `categoryChartType: "bar" | "pie" | "line"`.

#### 5.2 Ledger Group

- **Card name**: `Sales by Ledger Group`.
- **Grouping key**: `ledgerGroup`.
- **Metric**: sum of `amount`.
- **Charts supported**:
  - Bar, pie, line.
- **Parameters**:
  - `ledgerGroupChartType: "bar" | "pie" | "line"`.

#### 5.3 Region / State

- **Card name**: `Sales by State`.
- **Grouping key**: `region` (state code or name).
- **Metric**: sum of `amount`.
- **Charts supported**:
  - Bar, pie, line, **geo map**.
- **Parameters**:
  - `regionChartType: "bar" | "pie" | "line" | "geoMap"`.
  - `regionMapSubType: "choropleth" | "bubble"` (or equivalent subtypes).
- **Map data dependencies**:
  - Static state geometry (e.g., `indiaStates.json`).
  - Optional pincode coordinate data for drill‑down.

#### 5.4 Country

- **Card name**: `Sales by Country`.
- **Grouping key**: `country` (default to `"Unknown"` when absent).
- **Metric**: sum of `amount`.
- **Charts supported**:
  - Bar, pie, line, geo map.
- **Parameters**:
  - `countryChartType: "bar" | "pie" | "line" | "geoMap"`.
  - `countryMapSubType: same as regionMapSubType`.
- **Map data dependencies**:
  - World country geometry (e.g., `worldCountries.json`).

#### 5.5 Sales by Period (Month)

- **Card name**: `Sales by Period`.
- **Grouping key**:
  - Month string derived from `cp_date` or `date` → `YYYY-MM`.
- **Metric**: sum of `amount`.
- **Charts supported**:
  - Bar, pie, line.
- **Parameters**:
  - `periodChartType: "bar" | "pie" | "line"`.

#### 5.6 Top Customers

- **Card name**: `Top Customers Chart`.
- **Grouping key**: `customer` (case‑insensitive).
- **Metrics**:
  - Primary: sum of `amount` (revenue).
- **Charts supported**:
  - Bar, pie, line.
- **Parameters**:
  - `topCustomersN: number` – how many top customers to show.
  - `topCustomersChartType: "bar" | "pie" | "line"`.

#### 5.7 Top Items by Revenue

- **Card name**: `Top Items by Revenue Chart`.
- **Grouping key**: `item`.
- **Metrics**:
  - `revenue`: sum of `amount`.
  - `quantity`: (optional) sum of `quantity` (for tooltips/secondary plot).
- **Charts supported**:
  - Bar, pie, line.
- **Parameters**:
  - `topItemsByRevenueN: number`.
  - `topItemsByRevenueChartType: "bar" | "pie | "line"`.

#### 5.8 Top Items by Quantity

- **Card name**: `Top Items by Quantity Chart`.
- **Grouping key**: `item`.
- **Metric**: sum of `quantity`.
- **Charts supported**:
  - Bar, pie, line.
- **Parameters**:
  - `topItemsByQuantityN: number`.
  - `topItemsByQuantityChartType: "bar" | "pie" | "line"`.

#### 5.9 Revenue vs Profit

- **Card name**: `Revenue vs Profit`.
- **Grouping key**: usually `customer` or `item` depending on implementation; in the current dashboard it is per period or entity defined in code.
- **Metrics per label**:
  - `revenue`: aggregated `amount`.
  - `profit`: aggregated `profit`.
- **Charts supported**:
  - Combined bar/line or multi‑axis chart via a `MultiAxisChart` component.

#### 5.10 Salesperson Totals

- **Card name**: `Salesperson Totals`.
- **Grouping key**: `salesperson` (falls back to `'Unassigned'` if missing).
- **Metrics per salesperson**:
  - `value`: sum of `amount` (revenue) for that salesperson.
  - `billCount`: number of sale records (invoices/items) attributed to that salesperson.
- **Charts supported**:
  - Bar chart (used for both on-screen display and exports).
- **Parameters & configuration**:
  - Uses `enabledSalespersons: Set<string>` to control which salespersons are included:
    - Before initialization: empty set means “all salespersons enabled”.
    - After initialization: empty set means “show none” (user has deselected all).
  - Tied to `selectedSalesperson` and `showSalespersonConfig` UI to let the user pick which salespersons to include.

#### 5.11 Top Profitable / Loss‑Making Items

- **Card name**: `Top Profitable Items`, `Top Loss Items`.
- **Grouping key**: `item`.
- **Metric**: sum of `profit`.
- **Charts supported**:
  - Bar (primary), optionally others.

#### 5.12 Month‑wise Profit

- **Card name**: `Month-wise Profit`.
- **Grouping key**: month (`YYYY-MM`) from `cp_date` or `date`.
- **Metric**: sum of `profit`.
- **Charts supported**:
  - Bar, pie, line.
- **Parameters**:
  - `monthWiseProfitChartType: "bar" | "pie" | "line"`.

#### 5.13 Geo Map Chart Configuration (Shared)

Some cards can render geographic visualizations using a generic geo map chart component (equivalent of `GeoMapChart`):

- **Input data format**:
  - `{ name: string, value: number }[]` where `name` is a state/country/pincode key and `value` is a numeric metric (usually revenue).
- **Common props / parameters**:
  - `mapType`: `'india' | 'world' | 'pincode'` (or equivalent) – selects which base geometry dataset to use.
  - `chartSubType`: `'choropleth' | 'bubble'` – fill color per region vs bubble overlays.
  - `isMobile`: boolean to choose appropriate layout and label density.
  - `data`: array of name/value pairs as described above.
- **Static data dependencies**:
  - Country / state geometry (e.g., `indiaStates.json`, `worldCountries.json`).
  - Optional pincode coordinate mapping for region drill‑down.

---

### 6. Card Permissions, Visibility & Ordering

- **Permissions**
  - Backend exposes user modules and permissions (e.g., module `sales_dashboard` with a list of permission display names).
  - There is a mapping:
    - **Permission display name → Card title** (e.g., `"Ledger Group wise Sales" → "Sales by Ledger Group"`).
  - Only cards whose permissions are granted are eligible to render.

- **Visibility overrides**
  - User can temporarily hide/show cards.
  - Visibility is stored in a `cardVisibility` map: `{ [cardTitle: string]: booleanHiddenFlag }`.
  - Effective visibility:
    - Card must be **enabled by backend** AND **not explicitly hidden by user**.

- **Ordering**
  - Each card can have a sort index.
  - Stored as `cardSortIndex: { [cardTitle: string]: number }`.
  - Default order is defined by layout; unspecified cards get a high default index.

- **Fullscreen support**
  - Any card (metric or chart) can be opened in a fullscreen modal.
  - State: `fullscreenCard = { type: "metric" | "chart" | "custom", title: string, cardId?: string }`.

---

### 7. Date Handling & Per‑Card Periods

- **Global date defaults**
  - Derived from:
    - Company’s `booksFromDate`.
    - Stored default period preference (e.g., last month, current FY, custom).

- **Per‑card date overrides**
  - Each card can be configured with its own period:
    - Example: `Last 7 days`, `Last quarter`, `Full financial year`.
  - Stored in `cardPeriodSettings: { [cardName: string]: { fromDate, toDate, periodType, isDefault: boolean } }`.
  - When a card has a specific period:
    - `getCardDataSource(cardName)` uses `allCachedSales` (full cached vouchers) filtered by this card‑specific period instead of the dashboard’s global `filteredSales`.

- **Card period selection UI**
  - A modal allows selecting:
    - Period type (financial year, quarter, month, week, custom).
    - From/to dates.
    - “Set as default for this card” flag.

---

### 8. Multi‑Company Behaviour

- Users can select multiple companies, but many actions assume a **primary company context**:
  - `getSelectedCompanies()` returns a list.
  - Cache sync and progress tracking are scoped per company.
  - Loading sales data:
    - Uses the currently selected company list and its respective complete cache(s).

- Cache manager responsibilities:
  - Maintain per‑company:
    - Cache blobs.
    - Sync progress.
    - Last updated timestamps.
  - Expose:
    - `getCompleteSalesData(companyInfo)`
    - `getCompanyProgress(companyInfo)`
    - `isSyncInProgress()`
    - `subscribe(callback)` for progress updates.

---

### 9. Number Formatting & UI Preferences

- **Number format**
  - Preference: `"indian"` (lakhs/crores) or `"international"` (thousands/millions/billions).
  - Affects how currency and large numbers are displayed in KPI cards and charts.

- **Profit KPI masking**
  - Profit‑related KPIs can be hidden/shown by user (config stored locally).

- **Card layout**
  - KPI cards are compact cards with:
    - Title, value, optional unit, optional target/difference, and trend sparkline.
  - Charts live inside a common `ChartCard` container with:
    - Title, chart type selector, filters, options menu (e.g., fullscreen, export).

---

### 10. Drill‑Down & Supporting Features

- **Voucher / bill drill‑down**
  - From charts or tables, user can:
    - Open a bill‑level drill‑down modal using `masterid` to fetch / filter voucher details.
    - Open a voucher‑details modal using an internal `selectedMasterId`.

- **Raw data view**
  - A generic table view of `filteredSales` (or a per‑card dataset) with:
    - Pagination (page, page size) and sort.
    - Column filters with search per column.

- **UDF‑based extensions**
  - UDF (User Defined Fields) config describes available calculated fields.
  - Users can:
    - Select UDFs to include in charts/filters.
    - Use these fields in custom cards.

---

### 11. Android / Cross‑Platform Implementation Notes

To replicate this dashboard in an Android app (or any other client):

- **Data layer**
  - Implement a **sales cache** store (Room DB / files) with:
    - `Voucher` entity matching the fields described in Section 2.
    - A cache metadata table for `cacheTimestamp` and per‑company info.
  - Implement a **cache sync manager** that:
    - Downloads vouchers from backend.
    - Stores them locally.
    - Broadcasts progress updates and interruption state.

- **Domain layer**
  - Implement reusable functions to:
    - Apply global filters and per‑card overrides to the cached vouchers.
    - Compute all KPIs and aggregated datasets described in Sections 4 and 5.
    - Respect permissions & visibility as described in Section 6.

- **UI layer**
  - Implement:
    - KPI cards with trend sparkline and target/difference support.
    - Reusable chart components: bar, pie, line, treemap, geo map (or equivalent).
    - Card containers with type toggles, fullscreen, and per‑card settings.
    - Global filter panels (dates, entities, salesperson, generic filters).

By following the above sections you can recreate a **functionally equivalent Sales Dashboard** on Android or any other platform, as long as the same cache structure, filters, KPIs, charts, and configuration semantics are preserved.

