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
      amount TEXT, iscancelled TEXT, isoptional TEXT, guid TEXT,
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

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY, value TEXT
    );
  `);
    console.log('[Worker] Schema created');
};

// ─── Data Insertion ─────────────────────────────────────────────────

const insertVouchers = (vouchers, guid) => {
    if (!vouchers || vouchers.length === 0) return 0;
    const stmtV = db.prepare(`INSERT OR REPLACE INTO vouchers (masterid,alterid,vouchertypename,vouchertypereservedname,vouchernumber,date,partyledgername,partyledgernameid,state,country,partygstin,pincode,address,amount,iscancelled,isoptional,guid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const stmtL = db.prepare(`INSERT INTO ledger_entries (voucher_masterid,guid,ledgername,ledgernameid,amount,isdeemedpositive,ispartyledger,groupname,groupofgroup,grouplist,ledgergroupidentify) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const stmtI = db.prepare(`INSERT INTO inventory_entries (voucher_masterid,guid,stockitemname,stockitemnameid,uom,actualqty,billedqty,rate,discount,amount,stockitemgroup,stockitemgroupofgroup,stockitemgrouplist,grosscost,grossexpense,profit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let count = 0;
    try {
        db.exec('BEGIN TRANSACTION');
        for (const v of vouchers) {
            db.exec(`DELETE FROM ledger_entries WHERE voucher_masterid='${v.masterid}' AND guid='${guid}'`);
            db.exec(`DELETE FROM inventory_entries WHERE voucher_masterid='${v.masterid}' AND guid='${guid}'`);
            const nd = parseTallyDate(v.date || '');
            stmtV.bind([v.masterid, parseInt(v.alterid) || 0, v.vouchertypename || '', v.vouchertypereservedname || '', v.vouchernumber || '', nd, v.partyledgername || '', v.partyledgernameid || '', v.state || '', v.country || '', v.partygstin || '', v.pincode || '', v.address || '', v.amount || '', v.iscancelled || 'No', v.isoptional || 'No', guid]);
            stmtV.step(); stmtV.reset();
            if (v.ledgerentries) {
                for (const le of v.ledgerentries) {
                    stmtL.bind([v.masterid, guid, le.ledgername || '', le.ledgernameid || '', le.amount || '', le.isdeemedpositive || '', le.ispartyledger || '', le.group || '', le.groupofgroup || '', le.grouplist || '', le.ledgergroupidentify || '']);
                    stmtL.step(); stmtL.reset();
                }
            }
            if (v.allinventoryentries) {
                for (const ie of v.allinventoryentries) {
                    stmtI.bind([v.masterid, guid, ie.stockitemname || '', ie.stockitemnameid || '', ie.uom || '', ie.actualqty || '', ie.billedqty || '', ie.rate || '', ie.discount || '', ie.amount || '', ie.stockitemgroup || '', ie.stockitemgroupofgroup || '', ie.stockitemgrouplist || '', ie.grosscost || '', ie.grossexpense || '', ie.profit || '']);
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
    db.exec(`DELETE FROM ledger_entries WHERE guid='${guid}'`);
    db.exec(`DELETE FROM inventory_entries WHERE guid='${guid}'`);
    db.exec(`DELETE FROM vouchers WHERE guid='${guid}'`);
    db.exec(`DELETE FROM sync_meta`);
    post('clear_complete', { message: 'Cache cleared' });
};

// ─── Dashboard Data (KPIs + Core Charts) ─────────────────────────────

const getDashboardData = (guid, fromDate, toDate) => {

    // ── Materialize filtered vouchers into temp table (scanned ONCE) ──
    // Note: db.exec() does not support parameter binding in sqlite-wasm,
    // so we use string interpolation here (guid/dates are internal values).
    db.exec(`DROP TABLE IF EXISTS _fv`);
    db.exec(`CREATE TEMP TABLE _fv AS
        SELECT masterid, date, partyledgername, state, country, amount,
               vouchertypereservedname,
               CASE WHEN vouchertypereservedname LIKE '%Credit Note%' THEN 1 ELSE 0 END AS is_cn,
               CAST(amount AS REAL) AS amt
        FROM vouchers
        WHERE guid='${guid}' AND iscancelled='No' AND date>='${fromDate}' AND date<='${toDate}'`);

    // Add index on the temp table for joins
    db.exec(`CREATE INDEX _fv_mid ON _fv(masterid)`);

    // ── KPIs (all from temp table) ──
    const totalSales = db.selectValue(`SELECT SUM(CASE WHEN is_cn THEN -amt ELSE amt END) FROM _fv`) || 0;
    const totalTxns = db.selectValue(`SELECT COUNT(*) FROM _fv`) || 0;
    const avgOrderValue = totalTxns > 0 ? totalSales / totalTxns : 0;
    const maxSale = db.selectValue(`SELECT MAX(amt) FROM _fv WHERE is_cn=0`) || 0;

    // ── Core charts ──
    const salesTrend = db.selectObjects(`SELECT date, SUM(CASE WHEN is_cn THEN -amt ELSE amt END) as total FROM _fv GROUP BY date ORDER BY date ASC`) || [];
    const salesByState = db.selectObjects(`SELECT COALESCE(NULLIF(state,''),'Unknown') as name, SUM(CASE WHEN is_cn THEN -amt ELSE amt END) as value FROM _fv GROUP BY name ORDER BY value DESC`) || [];
    const topCustomers = db.selectObjects(`SELECT partyledgername as name, SUM(CASE WHEN is_cn THEN -amt ELSE amt END) as value FROM _fv GROUP BY partyledgername ORDER BY value DESC LIMIT 10`) || [];
    const topItems = db.selectObjects(`SELECT i.stockitemname as name, SUM(CASE WHEN f.is_cn THEN -CAST(i.amount AS REAL) ELSE CAST(i.amount AS REAL) END) as value FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid=? GROUP BY i.stockitemname ORDER BY value DESC LIMIT 10`, [guid]) || [];

    // ── Extended data (reuses _fv temp table) ──
    const extended = getExtendedDashboardData(guid);

    db.exec(`DROP TABLE IF EXISTS _fv`);

    return {
        kpi: { totalSales, totalTxns, avgOrderValue, maxSale },
        charts: { salesTrend, salesByState, topCustomers, topItems },
        extended,
    };
};

// ─── Extended Dashboard Data (uses _fv temp table) ───────────────────

const getExtendedDashboardData = (guid) => {
    const gp = [guid];

    const salesByStockGroup = db.selectObjects(`SELECT i.stockitemgroup as name, SUM(CASE WHEN f.is_cn THEN -CAST(i.amount AS REAL) ELSE CAST(i.amount AS REAL) END) as value FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid=? GROUP BY i.stockitemgroup ORDER BY value DESC`, gp) || [];

    const salesByLedgerGroup = db.selectObjects(`SELECT l.groupname as name, SUM(CASE WHEN f.is_cn THEN -CAST(l.amount AS REAL) ELSE CAST(l.amount AS REAL) END) as value FROM ledger_entries l JOIN _fv f ON l.voucher_masterid=f.masterid WHERE l.guid=? AND l.ispartyledger='Yes' GROUP BY l.groupname ORDER BY value DESC`, gp) || [];

    const salesByCountry = db.selectObjects(`SELECT COALESCE(NULLIF(country,''),'Unknown') as name, SUM(CASE WHEN is_cn THEN -amt ELSE amt END) as value FROM _fv GROUP BY name ORDER BY value DESC`) || [];

    const salesByPeriod = db.selectObjects(`SELECT SUBSTR(date,1,6) as period, SUM(CASE WHEN is_cn THEN -amt ELSE amt END) as value FROM _fv GROUP BY period ORDER BY period ASC`) || [];

    const topItemsByQty = db.selectObjects(`SELECT i.stockitemname as name, SUM(CAST(i.billedqty AS REAL)) as value FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid=? GROUP BY i.stockitemname ORDER BY value DESC LIMIT 10`, gp) || [];

    const profitAnalysis = {
        revenue: db.selectValue(`SELECT SUM(CASE WHEN f.is_cn THEN -CAST(i.amount AS REAL) ELSE CAST(i.amount AS REAL) END) FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid=?`, gp) || 0,
        profit: db.selectValue(`SELECT SUM(CASE WHEN f.is_cn THEN -CAST(i.profit AS REAL) ELSE CAST(i.profit AS REAL) END) FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid=?`, gp) || 0,
    };

    const monthWiseProfit = db.selectObjects(`SELECT SUBSTR(f.date,1,6) as period, SUM(CASE WHEN f.is_cn THEN -CAST(i.profit AS REAL) ELSE CAST(i.profit AS REAL) END) as value FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid=? GROUP BY period ORDER BY period ASC`, gp) || [];

    const topProfitableItems = db.selectObjects(`SELECT i.stockitemname as name, SUM(CASE WHEN f.is_cn THEN -CAST(i.profit AS REAL) ELSE CAST(i.profit AS REAL) END) as value FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid=? GROUP BY i.stockitemname HAVING value > 0 ORDER BY value DESC LIMIT 10`, gp) || [];

    const topLossItems = db.selectObjects(`SELECT i.stockitemname as name, SUM(CASE WHEN f.is_cn THEN -CAST(i.profit AS REAL) ELSE CAST(i.profit AS REAL) END) as value FROM inventory_entries i JOIN _fv f ON i.voucher_masterid=f.masterid WHERE i.guid=? GROUP BY i.stockitemname HAVING value < 0 ORDER BY value ASC LIMIT 10`, gp) || [];

    return { salesByStockGroup, salesByLedgerGroup, salesByCountry, salesByPeriod, topItemsByQty, profitAnalysis, monthWiseProfit, topProfitableItems, topLossItems };
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

const computeAllCards = (cards, guid, fromDate, toDate) => {
    const result = {};
    for (const card of cards) {
        if (card.title === '__DASHBOARD_SETTINGS__') continue;
        result[card.id] = computeCardData(card, guid, fromDate, toDate);
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
                const data = getDashboardData(payload.guid, fromDate, toDate);
                post('dashboard_data', { data });
                break;
            }

            case 'get_custom_cards_data': {
                const fromDate = payload.fromDate || '00000000';
                const toDate = payload.toDate || '99999999';
                const cardsData = computeAllCards(payload.cards, payload.guid, fromDate, toDate);
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
