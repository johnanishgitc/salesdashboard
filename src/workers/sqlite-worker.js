import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

let db = null;

// ─── Helpers ────────────────────────────────────────────────────────

const post = (type, data = {}) => self.postMessage({ type, ...data });
const progress = (current, total, message) => post('progress', { current, total, message });

const fmtDate = (d) => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
};

const parseTallyDate = (dateStr) => {
    if (!dateStr) return '';
    if (/^\d{8}$/.test(dateStr)) return dateStr;
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        const day = parts[0].padStart(2, '0');
        const monthStr = parts[1];
        const year = parts[2].length === 2 ? '20' + parts[2] : parts[2];
        const months = {
            'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
            'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
        };
        const month = months[monthStr] || '00';
        return `${year}${month}${day}`;
    }
    return dateStr;
};

const chunkDates = (fromStr, toStr) => {
    const chunks = [];
    let cursor = new Date(parseInt(fromStr.slice(0, 4)), parseInt(fromStr.slice(4, 6)) - 1, parseInt(fromStr.slice(6, 8)));
    const end = new Date(parseInt(toStr.slice(0, 4)), parseInt(toStr.slice(4, 6)) - 1, parseInt(toStr.slice(6, 8)));
    while (cursor <= end) {
        const chunkEnd = new Date(cursor);
        chunkEnd.setDate(chunkEnd.getDate() + 1);
        const actualEnd = chunkEnd > end ? end : chunkEnd;
        chunks.push({ from: fmtDate(cursor), to: fmtDate(actualEnd) });
        cursor = new Date(actualEnd);
        cursor.setDate(cursor.getDate() + 1);
    }
    return chunks;
};

// ─── Database Init ─────────────────────────────────────────────────

const initDb = async () => {
    const sqlite3 = await sqlite3InitModule({
        print: (...args) => console.log('[SQLite]', ...args),
        printErr: (...args) => console.error('[SQLite]', ...args),
    });
    if (sqlite3.oo1.OpfsDb) {
        db = new sqlite3.oo1.OpfsDb('/sales_cache.db');
        console.log('[Worker] Opened OPFS database');
    } else {
        db = new sqlite3.oo1.DB(':memory:');
        console.warn('[Worker] OPFS not available, using in-memory DB');
    }

    db.exec(`
    CREATE TABLE IF NOT EXISTS vouchers (
      masterid TEXT, alterid INTEGER, vouchertypename TEXT, vouchertypereservedname TEXT,
      vouchernumber TEXT, date TEXT, partyledgername TEXT, partyledgernameid TEXT,
      state TEXT, country TEXT, partygstin TEXT, pincode TEXT, address TEXT,
      amount TEXT, iscancelled TEXT, isoptional TEXT, guid TEXT, salesperson TEXT,
      PRIMARY KEY (masterid, guid)
    );
    CREATE INDEX IF NOT EXISTS idx_vouchers_date ON vouchers(date);
    CREATE INDEX IF NOT EXISTS idx_vouchers_guid ON vouchers(guid);
    CREATE INDEX IF NOT EXISTS idx_vouchers_partyledgername ON vouchers(partyledgername);
    CREATE INDEX IF NOT EXISTS idx_vouchers_guid_cancel_date ON vouchers(guid, iscancelled, date);

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_masterid TEXT, guid TEXT, ledgername TEXT, ledgernameid TEXT,
      amount TEXT, isdeemedpositive TEXT, ispartyledger TEXT, groupname TEXT,
      groupofgroup TEXT, grouplist TEXT, ledgergroupidentify TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_le_voucher ON ledger_entries(voucher_masterid, guid);
    CREATE INDEX IF NOT EXISTS idx_le_groupname ON ledger_entries(groupname);
    CREATE INDEX IF NOT EXISTS idx_le_ispartyledger ON ledger_entries(ispartyledger);
    CREATE INDEX IF NOT EXISTS idx_le_voucher_group ON ledger_entries(voucher_masterid, guid, ispartyledger, groupname);
    CREATE INDEX IF NOT EXISTS idx_ledger_analytics ON ledger_entries(voucher_masterid, groupname, amount);

    CREATE TABLE IF NOT EXISTS inventory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_masterid TEXT, guid TEXT, stockitemname TEXT, stockitemnameid TEXT,
      uom TEXT, actualqty TEXT, billedqty TEXT, rate TEXT, discount TEXT,
      amount TEXT, stockitemgroup TEXT, stockitemgroupofgroup TEXT, stockitemgrouplist TEXT,
      grosscost TEXT, grossexpense TEXT, profit TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ie_voucher ON inventory_entries(voucher_masterid, guid);
    CREATE INDEX IF NOT EXISTS idx_ie_stockitemname ON inventory_entries(stockitemname);
    CREATE INDEX IF NOT EXISTS idx_ie_stockitemgroup ON inventory_entries(stockitemgroup);
    CREATE INDEX IF NOT EXISTS idx_ie_voucher_stock ON inventory_entries(voucher_masterid, guid, stockitemname);
    CREATE INDEX IF NOT EXISTS idx_inventory_analytics ON inventory_entries(voucher_masterid, stockitemgroup, stockitemname, amount, profit);

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY, value TEXT
    );

    CREATE TABLE IF NOT EXISTS agg_daily_stats (
      date TEXT,
      guid TEXT,
      total_sales REAL,
      total_txns INTEGER,
      max_sale REAL,
      PRIMARY KEY (guid, date)
    );

    CREATE TABLE IF NOT EXISTS agg_charts (
      guid TEXT,
      date TEXT,
      dim_type TEXT,
      dim_name TEXT,
      amount REAL,
      profit REAL,
      qty REAL
    );
    CREATE INDEX IF NOT EXISTS idx_agg_charts_main ON agg_charts(guid, dim_type, date);

    CREATE INDEX IF NOT EXISTS idx_vouchers_analytics 
    ON vouchers(guid, iscancelled, date, state, partyledgername, amount);
  `);

    // Migration: Add salesperson column if it makes sense (simple check by trying to add it)
    try {
        db.exec("ALTER TABLE vouchers ADD COLUMN salesperson TEXT");
        console.log('[Worker] Migrated: Added salesperson column');
    } catch (e) {
        // Ignore "duplicate column name" error
    }

    // Migration: Populate agg_daily_stats if empty but vouchers exist
    try {
        const hasVouchers = db.selectValue("SELECT 1 FROM vouchers LIMIT 1");
        const hasStats = db.selectValue("SELECT 1 FROM agg_daily_stats LIMIT 1");
        if (hasVouchers && !hasStats) {
             console.log('[Worker] Migrating: Populating aggregates...');
             // We need a GUID to rebuild. Just rebuild for all distinct GUIDs found.
             const guids = db.selectValues("SELECT DISTINCT guid FROM vouchers");
             for(const g of guids) {
                 rebuildAggregates(g);
             }
             console.log('[Worker] Migration complete: Aggregates populated');
        }
    } catch(e) {
        console.warn('[Worker] Aggregate migration failed', e);
    }

    console.log('[Worker] Schema created');
};

// ─── Data Insertion ─────────────────────────────────────────────────

const insertVouchers = (vouchers, guid) => {
    if (!vouchers || vouchers.length === 0) return 0;
    const stmtV = db.prepare(`INSERT OR REPLACE INTO vouchers (masterid,alterid,vouchertypename,vouchertypereservedname,vouchernumber,date,partyledgername,partyledgernameid,state,country,partygstin,pincode,address,amount,iscancelled,isoptional,guid,salesperson) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const stmtL = db.prepare(`INSERT INTO ledger_entries (voucher_masterid,guid,ledgername,ledgernameid,amount,isdeemedpositive,ispartyledger,groupname,groupofgroup,grouplist,ledgergroupidentify) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const stmtI = db.prepare(`INSERT INTO inventory_entries (voucher_masterid,guid,stockitemname,stockitemnameid,uom,actualqty,billedqty,rate,discount,amount,stockitemgroup,stockitemgroupofgroup,stockitemgrouplist,grosscost,grossexpense,profit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    // Helper to ensure we never pass an object/undefined to bind
    const s = (v) => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
    };
    const n = (v) => parseInt(v) || 0; // Safe number

    let count = 0;
    try {
        db.exec('BEGIN TRANSACTION');
        for (const v of vouchers) {
            db.exec(`DELETE FROM ledger_entries WHERE voucher_masterid='${v.masterid}' AND guid='${guid}'`);
            db.exec(`DELETE FROM inventory_entries WHERE voucher_masterid='${v.masterid}' AND guid='${guid}'`);
            const nd = parseTallyDate(v.date || '');

            // Bind vouchers (stmtV)
            // Extract salesperson using $Parent:Ledger:$PartyLedgerName logic
            // We need to look at the ledger entries for this voucher to find the party ledger's group
            let sp = '';
            // First check if explicit salesperson field exists in voucher
            sp = v.salesperson || v.SalesPerson || v.salesprsn || v.SalesPrsn || v.salespersonname || '';

            // If not found, try to derive from Party Ledger's Parent Group
            if (!sp && v.ledgerentries && v.partyledgername) {
                const partyEntry = v.ledgerentries.find(le =>
                    le.ledgername === v.partyledgername &&
                    (le.ispartyledger === 'Yes' || le.ispartyledger === true)
                );
                if (partyEntry) {
                    sp = partyEntry.groupname || partyEntry.parent || '';
                }
            }

            stmtV.bind([
                s(v.masterid), n(v.alterid), s(v.vouchertypename), s(v.vouchertypereservedname),
                s(v.vouchernumber), s(nd), s(v.partyledgername), s(v.partyledgernameid),
                s(v.state), s(v.country), s(v.partygstin), s(v.pincode), s(v.address),
                s(v.amount), s(v.iscancelled || 'No'), s(v.isoptional || 'No'), s(guid), s(sp)
            ]);
            stmtV.step(); stmtV.reset();

            // Bind ledger_entries (stmtL)
            if (v.ledgerentries) {
                for (const le of v.ledgerentries) {
                    stmtL.bind([
                        s(v.masterid), s(guid), s(le.ledgername), s(le.ledgernameid),
                        s(le.amount), s(le.isdeemedpositive), s(le.ispartyledger),
                        s(le.group), s(le.groupofgroup), s(le.grouplist), s(le.ledgergroupidentify)
                    ]);
                    stmtL.step(); stmtL.reset();
                }
            }

            // Bind inventory_entries (stmtI)
            if (v.allinventoryentries) {
                for (const ie of v.allinventoryentries) {
                    stmtI.bind([
                        s(v.masterid), s(guid), s(ie.stockitemname), s(ie.stockitemnameid),
                        s(ie.uom), s(ie.actualqty), s(ie.billedqty), s(ie.rate), s(ie.discount),
                        s(ie.amount), s(ie.stockitemgroup), s(ie.stockitemgroupofgroup),
                        s(ie.stockitemgrouplist), s(ie.grosscost), s(ie.grossexpense), s(ie.profit)
                    ]);
                    stmtI.step(); stmtI.reset();
                }
            }
            count++;
        }
        db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    finally { stmtV.finalize(); stmtL.finalize(); stmtI.finalize(); }
    return count;
};

const rebuildAggregates = (guid) => {
    try {
        db.exec('BEGIN TRANSACTION');
        
        // 1. Core Daily Stats
        db.exec(`DELETE FROM agg_daily_stats WHERE guid='${guid}'`);
        db.exec(`
            INSERT INTO agg_daily_stats (date, guid, total_sales, total_txns, max_sale)
            SELECT 
              date, '${guid}', 
              SUM(CASE WHEN vouchertypereservedname LIKE '%Credit Note%' THEN -CAST(amount AS REAL) ELSE CAST(amount AS REAL) END),
              COUNT(*),
              MAX(CASE WHEN vouchertypereservedname NOT LIKE '%Credit Note%' THEN CAST(amount AS REAL) ELSE 0 END)
            FROM vouchers 
            WHERE guid='${guid}' AND iscancelled='No'
            GROUP BY date
        `);

        // Check for salesperson column existence to prevent crash
        const cols = db.selectObjects(`PRAGMA table_info(vouchers)`);
        const hasSalesperson = cols.some(c => c.name === 'salesperson');
        const spCol = hasSalesperson ? 'salesperson' : "'' as salesperson";

        // 2. Extended Charts Aggregation (Pre-calculate all chart data)
        db.exec(`DELETE FROM agg_charts WHERE guid='${guid}'`);
        
        db.exec(`DROP TABLE IF EXISTS _v_agg`);
        db.exec(`
            CREATE TEMP TABLE _v_agg AS 
            SELECT 
                masterid, 
                CASE WHEN vouchertypereservedname LIKE '%Credit Note%' THEN -1 ELSE 1 END as sign,
                country,
                ${spCol},
                amount,
                date
            FROM vouchers 
            WHERE guid='${guid}' AND iscancelled='No'
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_v_agg_id ON _v_agg(masterid)`);

        // Stock Groups
        db.exec(`
            INSERT INTO agg_charts (guid, date, dim_type, dim_name, amount)
            SELECT '${guid}', v.date, 'stock_group', i.stockitemgroup, SUM(v.sign * CAST(i.amount AS REAL))
            FROM inventory_entries i JOIN _v_agg v ON i.voucher_masterid=v.masterid 
            GROUP BY v.date, i.stockitemgroup
        `);

        // Ledger Groups
        db.exec(`
            INSERT INTO agg_charts (guid, date, dim_type, dim_name, amount)
            SELECT '${guid}', v.date, 'ledger_group', l.groupname, SUM(v.sign * CAST(l.amount AS REAL))
            FROM ledger_entries l JOIN _v_agg v ON l.voucher_masterid=v.masterid 
            GROUP BY v.date, l.groupname
        `);

        // Country
        db.exec(`
            INSERT INTO agg_charts (guid, date, dim_type, dim_name, amount)
            SELECT '${guid}', date, 'country', COALESCE(NULLIF(country,''),'Unknown'), SUM(sign * CAST(amount AS REAL))
            FROM _v_agg GROUP BY date, country
        `);

        // Salesperson
        db.exec(`
            INSERT INTO agg_charts (guid, date, dim_type, dim_name, amount)
            SELECT '${guid}', date, 'salesperson', COALESCE(NULLIF(salesperson,''),'Unknown'), SUM(sign * CAST(amount AS REAL))
            FROM _v_agg GROUP BY date, salesperson
        `);

        // Items
        db.exec(`
            INSERT INTO agg_charts (guid, date, dim_type, dim_name, amount, qty, profit)
            SELECT '${guid}', v.date, 'item', i.stockitemname, 
                   SUM(v.sign * CAST(i.amount AS REAL)),
                   SUM(CAST(i.billedqty AS REAL)),
                   SUM(CAST(i.profit AS REAL))
            FROM inventory_entries i JOIN _v_agg v ON i.voucher_masterid=v.masterid 
            GROUP BY v.date, i.stockitemname
        `);

        db.exec(`DROP TABLE IF EXISTS _v_agg`);
        db.exec('COMMIT');
        console.log('[Worker] Aggregates rebuilt successfully');
    } catch(e) {
        console.error('[Worker] rebuildAggregates failed', e);
        db.exec('ROLLBACK');
        post('error', { message: `Aggregate Build Failed: ${e.message}` });
    }
};

// ─── Fetch from API ─────────────────────────────────────────────────

const fetchChunk = async (payload, token) => {
    const response = await fetch('/api/reports/salesextract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`API error: ${response.status} ${response.statusText}`);
    return response.json();
};

// ─── Download ───────────────────────────────────────────────────────

const handleDownload = async (payload) => {
    const { tallyloc_id, company, guid, fromdate, todate, token } = payload;
    const chunks = chunkDates(fromdate, todate);
    let totalRecords = 0;
    post('status', { status: 'downloading', message: `Starting download: ${chunks.length} chunks` });
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        progress(i + 1, chunks.length, `Fetching ${chunk.from} → ${chunk.to}`);
        try {
            const data = await fetchChunk({ tallyloc_id, company, guid, fromdate: chunk.from, todate: chunk.to, lastaltid: 0, serverslice: 'No', vouchertype: '$$isSales, $$IsCreditNote' }, token);
            if (data.vouchers && data.vouchers.length > 0) totalRecords += insertVouchers(data.vouchers, guid);
        } catch (err) {
            console.error(`[Worker] Chunk failed:`, err);
            post('error', { message: `Failed on chunk ${chunk.from}: ${err.message}` });
        }
    }
    const now = new Date().toISOString();
    db.exec(`INSERT OR REPLACE INTO sync_meta (key,value) VALUES ('last_sync_time','${now}')`);
    db.exec(`INSERT OR REPLACE INTO sync_meta (key,value) VALUES ('last_sync_guid','${guid}')`);
    db.exec(`INSERT OR REPLACE INTO sync_meta (key,value) VALUES ('last_sync_from','${fromdate}')`);
    db.exec(`INSERT OR REPLACE INTO sync_meta (key,value) VALUES ('last_sync_to','${todate}')`);
    
    post('status', { status: 'downloading', message: 'Finalizing: Building aggregates...' });
    rebuildAggregates(guid);

    post('download_complete', { totalRecords, message: `Download complete: ${totalRecords} vouchers synced` });
};

// ─── Update ─────────────────────────────────────────────────────────

const handleUpdate = async (payload) => {
    const { tallyloc_id, company, guid, token } = payload;
    const maxAlterId = db.selectValue(`SELECT COALESCE(MAX(alterid),0) FROM vouchers WHERE guid=?`, [guid]);
    const fromdate = db.selectValue(`SELECT value FROM sync_meta WHERE key='last_sync_from'`) || '20250401';
    const todate = fmtDate(new Date());
    const chunks = chunkDates(fromdate, todate);
    let totalRecords = 0;
    post('status', { status: 'updating', message: `Fetching updates since alterid ${maxAlterId}` });
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        progress(i + 1, chunks.length, `Updating ${chunk.from} → ${chunk.to}`);
        try {
            const data = await fetchChunk({ tallyloc_id, company, guid, fromdate: chunk.from, todate: chunk.to, lastaltid: maxAlterId, serverslice: 'No', vouchertype: '$$isSales, $$IsCreditNote' }, token);
            if (data.vouchers && data.vouchers.length > 0) totalRecords += insertVouchers(data.vouchers, guid);
        } catch (err) { console.error(`[Worker] Update chunk failed:`, err); }
    }
    const now = new Date().toISOString();
    db.exec(`INSERT OR REPLACE INTO sync_meta (key,value) VALUES ('last_sync_time','${now}')`);
    db.exec(`INSERT OR REPLACE INTO sync_meta (key,value) VALUES ('last_sync_to','${todate}')`);
    
    post('status', { status: 'updating', message: 'Finalizing: Updating aggregates...' });
    rebuildAggregates(guid);

    post('update_complete', { totalRecords, message: `Update complete: ${totalRecords} vouchers` });
};

// ─── Stats & Clear ──────────────────────────────────────────────────

const getStats = (guid) => ({
    totalVouchers: db.selectValue(`SELECT COUNT(*) FROM vouchers WHERE guid=?`, [guid]) || 0,
    totalLedgerEntries: db.selectValue(`SELECT COUNT(*) FROM ledger_entries WHERE guid=?`, [guid]) || 0,
    totalInventoryEntries: db.selectValue(`SELECT COUNT(*) FROM inventory_entries WHERE guid=?`, [guid]) || 0,
    dateRange: {
        min: db.selectValue(`SELECT MIN(date) FROM vouchers WHERE guid=?`, [guid]) || 'N/A',
        max: db.selectValue(`SELECT MAX(date) FROM vouchers WHERE guid=?`, [guid]) || 'N/A',
    },
    lastSync: db.selectValue(`SELECT value FROM sync_meta WHERE key='last_sync_time'`) || 'Never',
    maxAlterId: db.selectValue(`SELECT COALESCE(MAX(alterid),0) FROM vouchers WHERE guid=?`, [guid]) || 0,
});

const handleClear = (guid) => {
    db.exec(`DELETE FROM agg_daily_stats WHERE guid='${guid}'`);
    db.exec(`DELETE FROM agg_charts WHERE guid='${guid}'`);
    db.exec(`DELETE FROM ledger_entries WHERE guid='${guid}'`);
    db.exec(`DELETE FROM inventory_entries WHERE guid='${guid}'`);
    db.exec(`DELETE FROM vouchers WHERE guid='${guid}'`);
    db.exec(`DELETE FROM sync_meta`);
    post('clear_complete', { message: 'Cache cleared' });
};

// ─── Dashboard Data (KPIs + Core Charts) ─────────────────────────────

const getDashboardData = (guid, fromDate, toDate, filters = {}) => {
    const safe = (val) => val ? String(val).replace(/'/g, "''") : '';
    
    // Check if we have item-level filters that require complex joining/filtering
    const hasItemFilter = !!(filters.stockGroup || filters.stockItem || filters.ledgerGroup);
    
    // FAST PATH: If no complex item filters, use agg_daily_stats and direct index scans
    if (!hasItemFilter) {
        // 1. KPIs & Trend from agg_daily_stats (Instant)
        // Check filtering for State/Country/Customer/Salesperson which agg_daily_stats DOES NOT support
        // agg_daily_stats is only (guid, date). 
        // If we have state/customer filters, we cannot use agg_daily_stats for KPIs.
        const hasDimensionFilter = !!(filters.state || filters.country || filters.customer || filters.salesperson || filters.period);
        
        // If query is PURE (only Date Range), use Aggregates
        if (!hasDimensionFilter) {
            const rawKpi = db.selectObject(`
                SELECT 
                    SUM(total_sales) as totalSales, 
                    SUM(total_txns) as totalTxns, 
                    MAX(max_sale) as maxSale 
                FROM agg_daily_stats 
                WHERE guid='${guid}' AND date>='${fromDate}' AND date<='${toDate}'
            `);
            
            const kpi = {
                totalSales: rawKpi?.totalSales || 0,
                totalTxns: rawKpi?.totalTxns || 0,
                maxSale: rawKpi?.maxSale || 0
            };
            
            kpi.avgOrderValue = kpi.totalTxns > 0 ? kpi.totalSales / kpi.totalTxns : 0;

            const salesTrend = db.selectObjects(`
                SELECT date, total_sales as total 
                FROM agg_daily_stats 
                WHERE guid='${guid}' AND date>='${fromDate}' AND date<='${toDate}' 
                ORDER BY date ASC
            `) || [];

            // 2. Dimensional Charts (Direct Index Scan on Vouchers)
            // Using idx_vouchers_analytics: (guid, iscancelled, date, state, partyledgername, amount)
            const baseWhere = `guid='${guid}' AND iscancelled='No' AND date>='${fromDate}' AND date<='${toDate}'`;
            
            const salesByState = db.selectObjects(`
                SELECT COALESCE(NULLIF(state,''),'Unknown') as name, 
                       SUM(CASE WHEN vouchertypereservedname LIKE '%Credit Note%' THEN -CAST(amount AS REAL) ELSE CAST(amount AS REAL) END) as value 
                FROM vouchers 
                WHERE ${baseWhere} 
                GROUP BY name ORDER BY value DESC
            `) || [];

            const topCustomers = db.selectObjects(`
                SELECT partyledgername as name, 
                       SUM(CASE WHEN vouchertypereservedname LIKE '%Credit Note%' THEN -CAST(amount AS REAL) ELSE CAST(amount AS REAL) END) as value 
                FROM vouchers 
                WHERE ${baseWhere} 
                GROUP BY partyledgername ORDER BY value DESC LIMIT 10
            `) || [];

            // 3. Top Items (Join Inventory) - Still need join, but avoid _fv creation
            const topItems = db.selectObjects(`
                SELECT i.stockitemname as name, 
                       SUM(CASE WHEN v.vouchertypereservedname LIKE '%Credit Note%' THEN -CAST(i.amount AS REAL) ELSE CAST(i.amount AS REAL) END) as value 
                FROM inventory_entries i 
                JOIN vouchers v ON i.voucher_masterid = v.masterid 
                WHERE v.guid='${guid}' AND v.iscancelled='No' AND v.date>='${fromDate}' AND v.date<='${toDate}'
                GROUP BY i.stockitemname ORDER BY value DESC LIMIT 10
            `) || [];

            // 4. Extended Data (Direct)
            return { kpi, charts: { salesTrend, salesByState, topCustomers, topItems } };
        }
    }

    // SLOW PATH: Fallback to Temp Table (_fv) for complex filters
    let filterClauses = "";
    if (filters.stockGroup) filterClauses += ` AND masterid IN (SELECT voucher_masterid FROM inventory_entries WHERE guid='${guid}' AND stockitemgroup='${safe(filters.stockGroup)}')`;
    if (filters.ledgerGroup) filterClauses += ` AND masterid IN (SELECT voucher_masterid FROM ledger_entries WHERE guid='${guid}' AND groupname='${safe(filters.ledgerGroup)}')`;
    if (filters.state) filterClauses += ` AND state='${safe(filters.state)}'`;
    if (filters.country) filterClauses += ` AND country='${safe(filters.country)}'`;
    if (filters.customer) filterClauses += ` AND partyledgername='${safe(filters.customer)}'`;
    if (filters.salesperson) filterClauses += ` AND salesperson='${safe(filters.salesperson)}'`;
    if (filters.period) filterClauses += ` AND SUBSTR(date,1,6)='${safe(filters.period)}'`;
    if (filters.stockItem) filterClauses += ` AND masterid IN (SELECT voucher_masterid FROM inventory_entries WHERE guid='${guid}' AND stockitemname='${safe(filters.stockItem)}')`;

    // ── Materialize filtered vouchers into temp table ──
    db.exec(`DROP TABLE IF EXISTS _fv`);
    db.exec(`CREATE TEMP TABLE _fv AS
        SELECT masterid, date, partyledgername, state, country, amount,
               vouchertypereservedname, salesperson,
               CASE WHEN vouchertypereservedname LIKE '%Credit Note%' THEN 1 ELSE 0 END AS is_cn,
               CAST(amount AS REAL) AS amt
        FROM vouchers
        WHERE guid='${guid}' AND iscancelled='No' AND date>='${fromDate}' AND date<='${toDate}' ${filterClauses}`);

    db.exec(`CREATE INDEX _fv_mid ON _fv(masterid)`);

    // ── KPIs ──
    let totalSales = 0;

    // PRECISION FIX: If filtering by item/group, sum only the MATCHING inventory entries
    if (hasItemFilter) {
        let invClauses = "";
        if (filters.stockGroup) invClauses += ` AND i.stockitemgroup='${safe(filters.stockGroup)}'`;
        if (filters.stockItem) invClauses += ` AND i.stockitemname='${safe(filters.stockItem)}'`;

        const qry = `
            SELECT SUM(
                CASE WHEN f.is_cn THEN -CAST(i.amount AS REAL) ELSE CAST(i.amount AS REAL) END
            ) 
            FROM inventory_entries i 
            JOIN _fv f ON i.voucher_masterid = f.masterid 
            WHERE i.guid='${guid}' ${invClauses}
        `;
        totalSales = db.selectValue(qry) || 0;
    } else {
        // Otherwise use the voucher totals (Bill Value)
        totalSales = db.selectValue(`SELECT SUM(CASE WHEN is_cn THEN -amt ELSE amt END) FROM _fv`) || 0;
    }

    const totalTxns = db.selectValue(`SELECT COUNT(*) FROM _fv`) || 0;
    const avgOrderValue = totalTxns > 0 ? totalSales / totalTxns : 0;
    const maxSale = db.selectValue(`SELECT MAX(amt) FROM _fv WHERE is_cn=0`) || 0;

    // ── Core charts ──
    const salesTrend = db.selectObjects(`SELECT date, SUM(CASE WHEN is_cn THEN -amt ELSE amt END) as total FROM _fv GROUP BY date ORDER BY date ASC`) || [];
    const salesByState = db.selectObjects(`SELECT COALESCE(NULLIF(state,''),'Unknown') as name, SUM(CASE WHEN is_cn THEN -amt ELSE amt END) as value FROM _fv GROUP BY name ORDER BY value DESC`) || [];
    const topCustomers = db.selectObjects(`SELECT partyledgername as name, SUM(CASE WHEN is_cn THEN -amt ELSE amt END) as value FROM _fv GROUP BY partyledgername ORDER BY value DESC LIMIT 10`) || [];
    const topItems = db.selectObjects(`SELECT i.stockitemname as name, SUM(CASE WHEN f.is_cn THEN -CAST(i.amount AS REAL) ELSE CAST(i.amount AS REAL) END) as value FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid=? GROUP BY i.stockitemname ORDER BY value DESC LIMIT 10`, [guid]) || [];

    // ── Extended data ──
    db.exec(`DROP TABLE IF EXISTS _fv`);

    return {
        kpi: { totalSales, totalTxns, avgOrderValue, maxSale },
        charts: { salesTrend, salesByState, topCustomers, topItems },
    };
};

// ─── Extended Dashboard Data (uses _fv temp table) ───────────────────

// ─── Extended Dashboard Data (uses _fv temp table or direct query) ──

const getExtendedDashboardData = (guid) => {
    // Legacy: assumes _fv exists
    // ... code assuming _fv ...
    // Since we lazy load this inside getDashboardData "Slow Path", _fv exists there.
    // For Fast Path, we need a new function.
    return {
        salesByStockGroup: db.selectObjects(`SELECT i.stockitemgroup as name, SUM(CASE WHEN f.is_cn THEN -CAST(i.amount AS REAL) ELSE CAST(i.amount AS REAL) END) as value FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid='${guid}' GROUP BY name ORDER BY value DESC LIMIT 10`),
        salesByLedgerGroup: db.selectObjects(`SELECT l.groupname as name, SUM(CASE WHEN f.is_cn THEN -CAST(l.amount AS REAL) ELSE CAST(l.amount AS REAL) END) as value FROM ledger_entries l JOIN _fv f ON l.voucher_masterid=f.masterid WHERE l.guid='${guid}' GROUP BY name ORDER BY value DESC LIMIT 10`),
        salesByCountry: db.selectObjects(`SELECT COALESCE(NULLIF(country,''),'Unknown') as name, SUM(CASE WHEN is_cn THEN -amt ELSE amt END) as value FROM _fv GROUP BY name ORDER BY value DESC`),
        salesByPeriod: db.selectObjects(`SELECT SUBSTR(date,1,6) as period, SUM(CASE WHEN is_cn THEN -amt ELSE amt END) as value FROM _fv GROUP BY period ORDER BY period ASC`),
        monthWiseProfit: db.selectObjects(`SELECT SUBSTR(f.date,1,6) as period, SUM(CAST(i.profit AS REAL)) as value FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid='${guid}' GROUP BY period ORDER BY period ASC`),
        topItemsByQty: db.selectObjects(`SELECT i.stockitemname as name, SUM(CAST(i.billedqty AS REAL)) as value FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid='${guid}' GROUP BY name ORDER BY value DESC LIMIT 10`),
        salesBySalesperson: db.selectObjects(`SELECT COALESCE(NULLIF(salesperson,''),'Unknown') as name, SUM(CASE WHEN is_cn THEN -amt ELSE amt END) as value FROM _fv GROUP BY name ORDER BY value DESC`),
        topProfitableItems: db.selectObjects(`SELECT i.stockitemname as name, SUM(CAST(i.profit AS REAL)) as value FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid='${guid}' GROUP BY name ORDER BY value DESC LIMIT 10`),
        topLossItems: db.selectObjects(`SELECT i.stockitemname as name, SUM(CAST(i.profit AS REAL)) as value FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid='${guid}' GROUP BY name ORDER BY value ASC LIMIT 10`),
    };
};

// ─── Extended Data (Aggregated) ─────────────────────────────────────────────────
// ─── Extended Data (Aggregated) ─────────────────────────────────────────────────
const getExtendedDashboardData_Direct = (guid, fromDate, toDate) => {
    // Optimization: Check if aggregates exist. If not, rebuild them (Self-Healing).
    const hasData = db.selectValue(`SELECT 1 FROM agg_charts WHERE guid='${guid}' LIMIT 1`);
    
    if (!hasData) {
        console.warn('[Worker] Aggregates missing in getExtendedDashboardData, rebuilding...');
        // We need to check if we have data to rebuild from!
        const hasVouchers = db.selectValue(`SELECT 1 FROM vouchers WHERE guid='${guid}' LIMIT 1`);
        if (hasVouchers) {
             rebuildAggregates(guid);
        } else {
             return {}; // No data at all
        }
    }

    const aggQuery = (dimType, orderBy = 'DESC', limit = 10) => `
        SELECT dim_name as name, SUM(amount) as value 
        FROM agg_charts 
        WHERE guid='${guid}' AND dim_type='${dimType}' AND date>='${fromDate}' AND date<='${toDate}' 
        GROUP BY dim_name 
        ORDER BY value ${orderBy} 
        LIMIT ${limit}
    `;

    return {
        salesByStockGroup: db.selectObjects(aggQuery('stock_group')),
        salesByLedgerGroup: db.selectObjects(aggQuery('ledger_group')),
        salesByCountry: db.selectObjects(aggQuery('country')),
        salesBySalesperson: db.selectObjects(aggQuery('salesperson')),
        
        // Items
        // We stored items as 'item' dim_type with amount, qty, profit columns
        topItemsByQty: db.selectObjects(`
            SELECT dim_name as name, SUM(qty) as value 
            FROM agg_charts 
            WHERE guid='${guid}' AND dim_type='item' AND date>='${fromDate}' AND date<='${toDate}' 
            GROUP BY dim_name 
            ORDER BY value DESC 
            LIMIT 10
        `),
        topProfitableItems: db.selectObjects(`
            SELECT dim_name as name, SUM(profit) as value 
            FROM agg_charts 
            WHERE guid='${guid}' AND dim_type='item' AND date>='${fromDate}' AND date<='${toDate}' 
            GROUP BY dim_name 
            ORDER BY value DESC 
            LIMIT 10
        `),
        topLossItems: db.selectObjects(`
            SELECT dim_name as name, SUM(profit) as value 
            FROM agg_charts 
            WHERE guid='${guid}' AND dim_type='item' AND date>='${fromDate}' AND date<='${toDate}' 
            GROUP BY dim_name 
            ORDER BY value ASC 
            LIMIT 10
        `),

        // Period & Profit Trend (Monthly)
        salesByPeriod: db.selectObjects(`
            SELECT SUBSTR(date,1,6) as period, SUM(total_sales) as value 
            FROM agg_daily_stats 
            WHERE guid='${guid}' AND date>='${fromDate}' AND date<='${toDate}' 
            GROUP BY period ORDER BY period ASC
        `),
        
        monthWiseProfit: db.selectObjects(`
            SELECT SUBSTR(date,1,6) as period, SUM(profit) as value 
            FROM agg_charts 
            WHERE guid='${guid}' AND dim_type='item' AND date>='${fromDate}' AND date<='${toDate}' 
            GROUP BY period ORDER BY period ASC
        `),
    };
};


// ─── Dynamic Card Query Engine ──────────────────────────────────────

/**
 * Resolves a groupBy string to a SQL expression and required join.
 */
const resolveGroupBy = (groupBy) => {
    const map = {
        'month': { expr: "SUBSTR(v.date, 1, 6)", alias: 'name', table: 'v' },
        'quarter': { expr: "SUBSTR(v.date,1,4)||'-Q'||((CAST(SUBSTR(v.date,5,2) AS INTEGER)-1)/3+1)", alias: 'name', table: 'v' },
        'date': { expr: 'v.date', alias: 'name', table: 'v' },
        'week': { expr: "SUBSTR(v.date,1,4)||'-W'||PRINTF('%02d',(CAST(SUBSTR(v.date,5,2) AS INTEGER)-1)*4+CAST(SUBSTR(v.date,7,2) AS INTEGER)/7+1)", alias: 'name', table: 'v' },
        'item': { expr: 'i.stockitemname', alias: 'name', table: 'i' },
        'customer': { expr: 'v.partyledgername', alias: 'name', table: 'v' },
        'state': { expr: 'v.state', alias: 'name', table: 'v' },
        'country': { expr: "COALESCE(NULLIF(v.country,''),'Unknown')", alias: 'name', table: 'v' },
        'allinventoryentries.stockitemgroup': { expr: 'i.stockitemgroup', alias: 'name', table: 'i' },
        'ledgerentries.group': { expr: 'l.groupname', alias: 'name', table: 'l' },
    };
    return map[groupBy] || { expr: `v.${groupBy}`, alias: 'name', table: 'v' };
};

/**
 * Resolves a valueField + aggregation to a SQL expression.
 */
const resolveValue = (valueField, aggregation) => {
    if (aggregation === 'count') {
        if (valueField === 'transactions') return 'COUNT(DISTINCT v.masterid)';
        if (valueField === 'unique_customers') return 'COUNT(DISTINCT v.partyledgername)';
        if (valueField === 'unique_orders') return 'COUNT(DISTINCT v.masterid)';
        return 'COUNT(*)';
    }
    // sum aggregation
    const fieldMap = {
        'amount': "SUM(CASE WHEN v.vouchertypereservedname LIKE '%Credit Note%' THEN -CAST(v.amount AS REAL) ELSE CAST(v.amount AS REAL) END)",
        'profit': "SUM(CASE WHEN v.vouchertypereservedname LIKE '%Credit Note%' THEN -CAST(i.profit AS REAL) ELSE CAST(i.profit AS REAL) END)",
        'allinventoryentries.accountingallocation.amount': "SUM(CASE WHEN v.vouchertypereservedname LIKE '%Credit Note%' THEN -CAST(i.amount AS REAL) ELSE CAST(i.amount AS REAL) END)",
        'transactions': 'COUNT(DISTINCT v.masterid)',
        'unique_customers': 'COUNT(DISTINCT v.partyledgername)',
        'unique_orders': 'COUNT(DISTINCT v.masterid)',
    };
    return fieldMap[valueField] || `SUM(CAST(v.${valueField} AS REAL))`;
};

/**
 * Determines which tables need to be joined.
 */
const buildJoins = (needsInventory, needsLedger) => {
    let joins = '';
    if (needsInventory) joins += ' JOIN inventory_entries i ON i.voucher_masterid = v.masterid AND i.guid = v.guid';
    if (needsLedger) joins += ' JOIN ledger_entries l ON l.voucher_masterid = v.masterid AND l.guid = v.guid';
    return joins;
};

/**
 * Builds filter WHERE clauses from card filters config.
 */
const buildFilters = (filters) => {
    if (!filters || filters.length === 0) return { sql: '', params: [] };
    let sql = '';
    const params = [];
    for (const f of filters) {
        if (!f.filterField || !f.filterValues || f.filterValues.length === 0) continue;
        const fieldMap = {
            'ledgerentries.group': 'l.groupname',
            'ledgerentries.ledgername': 'l.ledgername',
            'allinventoryentries.stockitemgroup': 'i.stockitemgroup',
            'allinventoryentries.stockitemname': 'i.stockitemname',
        };
        const col = fieldMap[f.filterField] || f.filterField;
        const placeholders = f.filterValues.map(() => '?').join(',');
        sql += ` AND ${col} IN (${placeholders})`;
        params.push(...f.filterValues);
    }
    return { sql, params };
};

/**
 * Compute data for a single card configuration.
 */
const computeCardData = (card, guid, fromDate, toDate) => {
    try {
        const { groupBy, valueField, aggregation, topN, filters, cardConfig } = card;
        if (!groupBy || !valueField) return [];

        const grp = resolveGroupBy(groupBy);
        const segmentBy = cardConfig?.segmentBy;

        // Determine table needs
        const needsInventory = ['i'].includes(grp.table) ||
            (valueField && (valueField.includes('inventory') || valueField === 'profit')) ||
            (segmentBy === 'item');
        const needsLedger = ['l'].includes(grp.table) ||
            (filters && filters.some(f => f.filterField && f.filterField.startsWith('ledgerentries')));

        // Handle multi-axis charts
        if (card.chartType === 'multiAxis' && cardConfig?.multiAxisSeries) {
            return computeMultiAxisData(card, guid, fromDate, toDate);
        }

        const joins = buildJoins(needsInventory, needsLedger);
        const valExpr = resolveValue(valueField, aggregation);
        const filterResult = buildFilters(filters);

        // Handle segmented data (stacked charts)
        if (segmentBy) {
            return computeSegmentedData(card, guid, fromDate, toDate, grp, valExpr, joins, filterResult);
        }

        // Simple aggregation
        const orderDir = 'DESC';
        // Default limit to 20 to prevent chart text explosion, unless chartType is line (time series) or topN is specified
        let limitClause = '';
        if (topN) {
            limitClause = `LIMIT ${parseInt(topN)}`;
        } else if (card.chartType !== 'line') {
            limitClause = `LIMIT 10`;
        }

        const sql = `SELECT ${grp.expr} as name, ${valExpr} as value
      FROM vouchers v ${joins}
      WHERE v.guid = ? AND v.iscancelled = 'No' AND v.date >= ? AND v.date <= ? ${filterResult.sql}
      GROUP BY ${grp.expr}
      ORDER BY value ${orderDir} ${limitClause}`;

        const params = [guid, fromDate, toDate, ...filterResult.params];
        return db.selectObjects(sql, params) || [];
    } catch (err) {
        console.error(`[Worker] computeCardData error for ${card.title}:`, err);
        return [];
    }
};

/**
 * Compute segmented (stacked) data: groupBy + segmentBy → pivoted output.
 */
const computeSegmentedData = (card, guid, fromDate, toDate, grp, valExpr, joins, filterResult) => {
    const { cardConfig } = card;
    const segMap = {
        'date': { expr: 'v.date', table: 'v' },
        'month': { expr: "SUBSTR(v.date,1,6)", table: 'v' },
        'week': { expr: "SUBSTR(v.date,1,4)||'-W'||PRINTF('%02d',(CAST(SUBSTR(v.date,5,2) AS INTEGER)-1)*4+CAST(SUBSTR(v.date,7,2) AS INTEGER)/7+1)", table: 'v' },
        'item': { expr: 'i.stockitemname', table: 'i' },
        'quarter': { expr: "SUBSTR(v.date,1,4)||'-Q'||((CAST(SUBSTR(v.date,5,2) AS INTEGER)-1)/3+1)", table: 'v' },
        'customer': { expr: 'v.partyledgername', table: 'v' },
    };
    const seg = segMap[cardConfig.segmentBy] || { expr: `v.${cardConfig.segmentBy}`, table: 'v' };

    // Might need additional joins for segmentBy
    let extraJoin = '';
    if (seg.table === 'i' && !joins.includes('inventory_entries')) {
        extraJoin = ' JOIN inventory_entries i ON i.voucher_masterid = v.masterid AND i.guid = v.guid';
    }

    const topN = card.topN ? `LIMIT ${parseInt(card.topN)}` : 'LIMIT 10';

    // First get the groups (with optional topN)
    const groupSql = `SELECT ${grp.expr} as name, ${valExpr} as total
    FROM vouchers v ${joins} ${extraJoin}
    WHERE v.guid = ? AND v.iscancelled = 'No' AND v.date >= ? AND v.date <= ? ${filterResult.sql}
    GROUP BY ${grp.expr}
    ORDER BY total DESC ${topN}`;

    const groups = db.selectObjects(groupSql, [guid, fromDate, toDate, ...filterResult.params]) || [];
    if (groups.length === 0) return { groups: [], segments: [], data: [] };

    const groupNames = groups.map(g => g.name);
    const inPlaceholders = groupNames.map(() => '?').join(',');

    // Now get segmented data for those groups
    const segSql = `SELECT ${grp.expr} as name, ${seg.expr} as segment, ${valExpr} as value
    FROM vouchers v ${joins} ${extraJoin}
    WHERE v.guid = ? AND v.iscancelled = 'No' AND v.date >= ? AND v.date <= ? 
    AND ${grp.expr} IN (${inPlaceholders}) ${filterResult.sql}
    GROUP BY ${grp.expr}, ${seg.expr}
    ORDER BY ${grp.expr}, ${seg.expr}`;

    const rawData = db.selectObjects(segSql, [guid, fromDate, toDate, ...groupNames, ...filterResult.params]) || [];

    // Collect all unique segments and rank by total value
    const segTotals = {};
    rawData.forEach(r => {
        segTotals[r.segment] = (segTotals[r.segment] || 0) + Math.abs(r.value || 0);
    });

    // Keep only top 5 segments, group rest into "Other"
    const MAX_SEGMENTS = 5;
    const sortedSegs = Object.entries(segTotals).sort((a, b) => b[1] - a[1]);
    const topSegments = sortedSegs.slice(0, MAX_SEGMENTS).map(e => e[0]);
    const hasOther = sortedSegs.length > MAX_SEGMENTS;
    const segments = hasOther ? [...topSegments, 'Other'] : topSegments;

    // Build pivoted data: [{name: "Group1", "seg1": val, "seg2": val, "Other": val, ...}, ...]
    const pivoted = groupNames.map(name => {
        const row = { name };
        const rowData = rawData.filter(r => r.name === name);
        for (const s of topSegments) {
            const match = rowData.find(r => r.segment === s);
            row[s] = match ? match.value : 0;
        }
        if (hasOther) {
            row['Other'] = rowData
                .filter(r => !topSegments.includes(r.segment))
                .reduce((sum, r) => sum + (r.value || 0), 0);
        }
        return row;
    });

    return { groups: groupNames, segments, data: pivoted, isSegmented: true };
};

/**
 * Compute multi-axis chart data.
 */
const computeMultiAxisData = (card, guid, fromDate, toDate) => {
    const { groupBy, cardConfig } = card;
    const grp = resolveGroupBy(groupBy);
    const series = cardConfig.multiAxisSeries || [];
    const cardFilters = buildFilters(card.filters);

    // Determine all needed joins
    let needsInventory = ['i'].includes(grp.table);
    let needsLedger = ['l'].includes(grp.table) || (card.filters && card.filters.some(f => f.filterField && f.filterField.startsWith('ledgerentries')));

    for (const s of series) {
        if (s.field && (s.field.includes('inventory') || s.field === 'profit')) needsInventory = true;
        if (s.filters) {
            for (const f of s.filters) {
                if (f.filterField && f.filterField.startsWith('ledgerentries')) needsLedger = true;
            }
        }
    }

    const joins = buildJoins(needsInventory, needsLedger);

    // Build SELECT with all series as columns
    const selectParts = [`${grp.expr} as name`];
    const seriesInfo = [];

    for (const s of series) {
        const valExpr = resolveValue(s.field, s.aggregation || 'sum');
        const alias = s.id || s.label || s.field;
        selectParts.push(`${valExpr} as "${alias}"`);
        seriesInfo.push({ id: s.id, label: s.label, alias, axis: s.axis, type: s.type, field: s.field });
    }

    const sql = `SELECT ${selectParts.join(', ')}
    FROM vouchers v ${joins}
    WHERE v.guid = ? AND v.iscancelled = 'No' AND v.date >= ? AND v.date <= ? ${cardFilters.sql}
    GROUP BY ${grp.expr}
    ORDER BY ${grp.expr}
    LIMIT 10`;

    const data = db.selectObjects(sql, [guid, fromDate, toDate, ...cardFilters.params]) || [];

    return { data, seriesInfo, isMultiAxis: true };
};

// ─── Compute All Cards ──────────────────────────────────────────────

const computeAllCards = (cards, guid, fromDate, toDate, filters = {}) => {
    const result = {};
    for (const card of cards) {
        if (card.title === '__DASHBOARD_SETTINGS__') continue;
        result[card.id] = computeCardData(card, guid, fromDate, toDate, filters);
    }
    return result;
};

// ─── Message Handler ────────────────────────────────────────────────

self.onmessage = async (e) => {
    console.log('[Worker] v3.0 Loaded');
    const { type, payload } = e.data;
    console.log('[Worker] Received:', type);

    try {
        switch (type) {
            case 'init':
                await initDb();
                post('ready');
                break;

            case 'download':
                await handleDownload(payload);
                break;

            case 'update':
                await handleUpdate(payload);
                break;

            case 'get_stats': {
                const stats = getStats(payload.guid);
                post('stats', { stats });
                break;
            }

            case 'clear':
                handleClear(payload.guid);
                break;

            case 'get_dashboard_data': {
                const fromDate = payload.fromDate || '00000000';
                const toDate = payload.toDate || '99999999';
                const filters = payload.filters || {};
                const data = getDashboardData(payload.guid, fromDate, toDate, filters);
                post('dashboard_data', { data });
                break;
            }

            case 'get_extended_dashboard_data': {
                const fromDate = payload.fromDate || '00000000';
                const toDate = payload.toDate || '99999999';
                const filters = payload.filters || {};
                // Determine which method to use based on filters (Fast vs Slow Path logic duplicated? Or just use Direct for now?)
                // The worker's getDashboardData has complex logic for Fast/Slow.
                // We should probably expose a "getExtended" function that handles both?
                // For now, let's assume if it came here, it's either. 
                // Let's use getExtendedDashboardData_Direct if no complex filters, else Slow Path?
                // Actually, getExtendedDashboardData (Slow) relies on _fv existing, which is DROPPED at end of getDashboardData.
                // So we MUST use Direct or rebuild _fv.
                // Rebuilding _fv is slow. Direct is slow for FYTD.
                // Let's use Direct for now as it's the structure we have.
                // Optimally for FYTD we should use _fv.
                // FIX: Let's use Direct for "Extended" always for now, as it's cleaner.
                const data = getExtendedDashboardData_Direct(payload.guid, fromDate, toDate);
                post('extended_dashboard_data', { data });
                break;
            }

            case 'get_custom_cards_data': {
                const fromDate = payload.fromDate || '00000000';
                const toDate = payload.toDate || '99999999';
                const filters = payload.filters || {};
                const cardsData = computeAllCards(payload.cards, payload.guid, fromDate, toDate, filters);
                post('custom_cards_data', { cardsData });
                break;
            }

            case 'get_raw_data': {
                const limit = payload.limit || 100;
                const offset = payload.offset || 0;
                const guid = payload.guid;
                const totalVouchers = db.selectValue(`SELECT COUNT(*) FROM vouchers WHERE guid=?`, [guid]) || 0;
                const vouchers = db.selectObjects(
                    `SELECT * FROM vouchers WHERE guid=? ORDER BY date DESC, masterid DESC LIMIT ? OFFSET ?`,
                    [guid, limit, offset]
                ) || [];
                // Attach entries to each voucher
                const vouchersWithEntries = vouchers.map(v => {
                    const ledgerEntries = db.selectObjects(
                        `SELECT * FROM ledger_entries WHERE voucher_masterid=? AND guid=?`,
                        [v.masterid, guid]
                    ) || [];
                    const inventoryEntries = db.selectObjects(
                        `SELECT * FROM inventory_entries WHERE voucher_masterid=? AND guid=?`,
                        [v.masterid, guid]
                    ) || [];
                    return { ...v, ledgerEntries, inventoryEntries };
                });
                post('raw_data', {
                    data: {
                        totalVouchers,
                        showing: { offset, limit, count: vouchersWithEntries.length },
                        vouchers: vouchersWithEntries,
                    }
                });
                break;
            }

            default:
                console.warn('[Worker] Unknown message type:', type);
        }
    } catch (err) {
        console.error('[Worker] Error:', err);
        post('error', { message: err.message || 'An unknown error occurred' });
    }
};
