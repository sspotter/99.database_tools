import fs from 'node:fs';
import { singleStatement, pageOptions, quoteName } from './workspace-sql.js';

export function tlsOptions(settings) {
  if (settings.sslMode === 'disable') return false;
  return {
    rejectUnauthorized: settings.sslMode !== 'require',
    verifyIdentity: !['require', 'verify-ca'].includes(settings.sslMode),
    ...(settings.sslCa ? { ca: fs.readFileSync(settings.sslCa, 'utf8') } : {}),
    ...(settings.sslMode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
  };
}

async function postgresSession(settings, timeoutMs, setCancel) {
  const [{ default: pg }, { default: Cursor }] = await Promise.all([import('pg'), import('pg-cursor')]);
  const config = {
    host: settings.host, port: settings.port, user: settings.user, password: settings.password,
    database: settings.database, ssl: tlsOptions(settings), connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
  };
  const client = new pg.Client(config);
  client.on('error', () => {}); // Active query/connect promises carry the failure; avoid unhandled idle socket errors.
  setCancel(() => {
    if (client.activeQuery) {
      const cancellation = new pg.Client(config);
      cancellation.on('error', () => {});
      cancellation.cancel(client, client.activeQuery);
    } else client.end().catch(() => {});
  });
  try { await client.connect(); }
  catch (error) { await client.end(); throw error; }
  return {
    control: (sql) => client.query(sql),
    query: async (sql, params = [], cap = 10001) => {
      const cursor = client.query(new Cursor(sql, params));
      try {
        const rows = await cursor.read(cap);
        const columns = cursor._result.fields.map((field) => field.name);
        if (new Set(columns).size !== columns.length) throw new Error('Duplicate result column names; use distinct aliases');
        return { rows, columns, rowCount: cursor._result.rowCount };
      } finally { await cursor.close(); }
    },
    close: () => client.end(),
  };
}

async function mysqlSession(settings, timeoutMs, setCancel) {
  const { default: mysql } = await import('mysql2');
  const config = {
    host: settings.host, port: settings.port, user: settings.user, password: settings.password,
    database: settings.database, ssl: tlsOptions(settings) || undefined,
    connectTimeout: timeoutMs, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true,
    dateStrings: true,
  };
  const connection = mysql.createConnection(config);
  connection.on('error', () => {});
  setCancel(() => {
    // Closing a client socket alone can leave a server-side SLEEP/query running.
    const killer = mysql.createConnection({ ...config, connectTimeout: Math.min(timeoutMs, 1000) });
    killer.on('error', () => {});
    if (Number.isInteger(connection.threadId)) {
      killer.query(`KILL CONNECTION ${connection.threadId}`, () => killer.destroy());
    } else killer.destroy();
    connection.destroy();
  });
  try { await new Promise((resolve, reject) => connection.connect((error) => error ? reject(error) : resolve())); }
  catch (error) { connection.destroy(); throw error; }
  return {
    control: (sql) => connection.promise().query(sql),
    query: (sql, params = [], cap = 10001) => new Promise((resolve, reject) => {
      const rows = [];
      let columns = [];
      let rowCount;
      let duplicateColumns = false;
      const stream = connection.query(sql, params);
      stream.on('fields', (fields) => {
        columns = (fields ?? []).map((field) => field.name);
        duplicateColumns ||= new Set(columns).size !== columns.length;
      });
      stream.on('result', (row) => {
        if (row.affectedRows !== undefined && !columns.length) rowCount = row.affectedRows;
        else if (rows.length < cap) rows.push(row);
      });
      stream.once('error', reject);
      stream.once('end', () => duplicateColumns ? reject(new Error('Duplicate result column names; use distinct aliases')) : resolve({ columns, rows, rowCount }));
    }),
    close: () => connection.promise().end(),
  };
}

async function mssqlSession(settings, timeoutMs, setCancel) {
  const { default: mssql } = await import('mssql');
  const tls = tlsOptions(settings);
  const pool = new mssql.ConnectionPool({
    server: settings.host, port: settings.port, user: settings.user, password: settings.password,
    database: settings.database, connectionTimeout: timeoutMs, requestTimeout: timeoutMs,
    pool: { max: 1, min: 0 },
    options: { encrypt: tls !== false, trustServerCertificate: settings.sslMode === 'require',
      ...(tls && { cryptoCredentialsDetails: tls }) },
  });
  pool.on('error', () => {});
  let request;
  let transaction;
  let transactionRolledBack = false;
  setCancel(() => { request?.cancel(); pool.close().catch(() => {}); });
  try { await pool.connect(); }
  catch (error) { await pool.close(); throw error; }
  const query = (sql, params = [], cap = 10001) => new Promise((resolve, reject) => {
    request = (transaction ?? pool).request();
    params.forEach((value, index) => request.input(`p${index + 1}`, value));
    request.stream = true;
    request.arrayRowMode = true;
    const rows = [];
    let columns = [];
    let rowCount = 0;
    let error;
    request.on('recordset', (fields) => {
      if (!columns.length) columns = fields.map((field) => field.name);
      if (new Set(columns).size !== columns.length) error = new Error('Duplicate result column names; use distinct aliases');
    });
    request.on('row', (row) => { if (rows.length < cap) rows.push(Object.fromEntries(columns.map((column, index) => [column, row[index]]))); });
    request.on('rowsaffected', (count) => { rowCount += count; });
    request.on('error', (cause) => { error = cause; });
    request.on('done', () => {
      request = undefined;
      if (error) reject(error); else resolve({ columns, rows, rowCount });
    });
    request.query(sql).catch((cause) => { error = cause; });
  });
  return {
    query, control: (sql) => query(sql),
    begin: async () => {
      transaction = new mssql.Transaction(pool);
      transaction.on('rollback', () => { transactionRolledBack = true; });
      await transaction.begin();
    },
    commit: async () => { await transaction.commit(); transaction = undefined; },
    close: async () => {
      try { if (transaction && !transactionRolledBack) await transaction.rollback(); }
      finally { await pool.close(); }
    },
  };
}

const catalogs = {
  postgres: {
    databases: "SELECT datname AS name FROM pg_database WHERE datallowconn AND has_database_privilege(datname, 'CONNECT') ORDER BY datname",
    schemas: "SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' ORDER BY schema_name",
    tables: "SELECT table_schema AS schema, table_name AS name, CASE WHEN table_type='VIEW' THEN 'view' ELSE 'table' END AS type FROM information_schema.tables WHERE table_schema=$1 AND table_type IN ('BASE TABLE','VIEW') ORDER BY table_name",
    columns: `SELECT c.column_name AS name, c.data_type AS type, c.is_nullable='YES' AS nullable, c.column_default AS "default",
      EXISTS(SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage ku ON tc.constraint_name=ku.constraint_name AND tc.constraint_schema=ku.constraint_schema AND tc.table_name=ku.table_name
        WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=c.table_schema AND tc.table_name=c.table_name AND ku.column_name=c.column_name) AS "primaryKey"
      FROM information_schema.columns c WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position`,
    indexes: 'SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname=$1 AND tablename=$2 ORDER BY indexname',
    foreignKeys: `SELECT con.conname AS name, a.attname AS "column", nr.nspname AS "referencedSchema", tr.relname AS "referencedTable", ar.attname AS "referencedColumn"
      FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_class tr ON tr.oid=con.confrelid JOIN pg_namespace nr ON nr.oid=tr.relnamespace
      JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY AS keys(attnum,refattnum,position) ON true
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=keys.attnum JOIN pg_attribute ar ON ar.attrelid=tr.oid AND ar.attnum=keys.refattnum
      WHERE con.contype='f' AND n.nspname=$1 AND t.relname=$2 ORDER BY con.conname,keys.position`,
    definition: 'SELECT view_definition AS definition FROM information_schema.views WHERE table_schema=$1 AND table_name=$2',
  },
  mysql: {
    databases: 'SHOW DATABASES',
    schemas: 'SELECT DATABASE() AS name',
    tables: "SELECT TABLE_SCHEMA AS `schema`, TABLE_NAME AS name, CASE WHEN TABLE_TYPE='VIEW' THEN 'view' ELSE 'table' END AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_NAME",
    columns: "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE='YES' AS nullable, COLUMN_DEFAULT AS `default`, COLUMN_KEY='PRI' AS primaryKey FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",
    indexes: 'SELECT INDEX_NAME AS name, COLUMN_NAME AS `column`, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS position FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',
    foreignKeys: 'SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS `column`, REFERENCED_TABLE_SCHEMA AS referencedSchema, REFERENCED_TABLE_NAME AS referencedTable, REFERENCED_COLUMN_NAME AS referencedColumn FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL',
  },
  mssql: {
    databases: 'SELECT name FROM sys.databases WHERE HAS_DBACCESS(name)=1 ORDER BY name',
    schemas: "SELECT name FROM sys.schemas WHERE name NOT IN ('sys','INFORMATION_SCHEMA') ORDER BY name",
    tables: "SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name, CASE WHEN TABLE_TYPE='VIEW' THEN 'view' ELSE 'table' END AS type FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@p1 AND TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_NAME",
    columns: `SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS type, c.IS_NULLABLE AS nullable, c.COLUMN_DEFAULT AS [default],
      CASE WHEN EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME=ku.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA=ku.CONSTRAINT_SCHEMA AND tc.TABLE_NAME=ku.TABLE_NAME
        WHERE tc.CONSTRAINT_TYPE='PRIMARY KEY' AND tc.TABLE_SCHEMA=c.TABLE_SCHEMA AND tc.TABLE_NAME=c.TABLE_NAME AND ku.COLUMN_NAME=c.COLUMN_NAME) THEN 1 ELSE 0 END AS primaryKey
      FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_SCHEMA=@p1 AND c.TABLE_NAME=@p2 ORDER BY c.ORDINAL_POSITION`,
    indexes: `SELECT i.name, c.name AS [column], i.is_unique AS [unique], ic.key_ordinal AS position FROM sys.indexes i
      JOIN sys.tables t ON t.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id
      JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
      WHERE s.name=@p1 AND t.name=@p2 ORDER BY i.name,ic.key_ordinal`,
    foreignKeys: `SELECT fk.name, c.name AS [column], rs.name AS referencedSchema, rt.name AS referencedTable, rc.name AS referencedColumn
      FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id JOIN sys.tables t ON t.object_id=fk.parent_object_id
      JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.columns c ON c.object_id=t.object_id AND c.column_id=fkc.parent_column_id
      JOIN sys.tables rt ON rt.object_id=fkc.referenced_object_id JOIN sys.schemas rs ON rs.schema_id=rt.schema_id
      JOIN sys.columns rc ON rc.object_id=rt.object_id AND rc.column_id=fkc.referenced_column_id WHERE s.name=@p1 AND t.name=@p2`,
    definition: 'SELECT sm.definition FROM sys.sql_modules sm JOIN sys.objects o ON o.object_id=sm.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE s.name=@p1 AND o.name=@p2',
  },
};

export async function runServerTask(profile, task, timeoutMs, setCancel) {
  const engine = profile.engine;
  if (task.action === 'query' && profile.readOnly !== false && engine === 'mssql') {
    throw new Error('Read-only arbitrary SQL is unsupported for SQL Server; use read-only database credentials and explicitly enable queries');
  }
  const settings = { ...profile.settings, ...(task.database ? { database: task.database } : {}) };
  const connect = { postgres: postgresSession, mysql: mysqlSession, mssql: mssqlSession }[engine];
  const session = await connect(settings, timeoutMs, setCancel);
  const q = (name) => quoteName(name, engine);
  const parameter = (n) => engine === 'postgres' ? `$${n}` : engine === 'mssql' ? `@p${n}` : '?';
  const catalog = catalogs[engine];
  try {
    if (task.action === 'test') { await session.query('SELECT 1'); return { ok: true }; }
    const readOnly = task.action !== 'query' || profile.readOnly !== false;
    if (engine === 'mssql' && task.action === 'query') await session.begin();
    if (engine === 'postgres') await session.control(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    if (engine === 'postgres' && task.schema) {
      const schema = await session.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name=$1', [task.schema], 1);
      if (!schema.rows.length) throw new Error('Unknown or inaccessible schema');
      await session.query("SELECT set_config('search_path',$1,true)", [`${q(task.schema)}, pg_catalog`], 1);
    }
    if (engine === 'mysql') {
      if (task.schema) await session.control(`USE ${q(task.schema)}`);
      await session.control("SET SESSION sql_mode=REPLACE(@@sql_mode,'NO_BACKSLASH_ESCAPES','')");
      await session.control(readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
    }
    const metadata = async (sql, params = []) => {
      const result = await session.query(sql, params, 10001);
      if (result.rows.length > 10000) throw new Error('Metadata exceeds 10000 objects; select a smaller schema');
      return result.rows;
    };
    let result;
    if (task.action === 'databases') {
      const rows = await metadata(catalog.databases);
      result = { databases: rows.map((row) => row.name ?? Object.values(row)[0]) };
    } else if (task.action === 'schemas') {
      const rows = await metadata(catalog.schemas);
      result = { schemas: rows.map((row) => row.name).filter(Boolean) };
    } else if (task.action === 'query') {
      const { limit } = pageOptions(task);
      result = await session.query(singleStatement(task.sql, engine), [], limit + 1);
      result.hasMore = result.rows.length > limit;
      result.rows = result.rows.slice(0, limit);
    } else {
      const schema = task.schema ?? (engine === 'postgres' ? 'public' : engine === 'mssql' ? 'dbo' : settings.database);
      q(schema);
      const objects = await metadata(catalog.tables, [schema]);
      if (task.action === 'tables') result = { tables: objects };
      else {
        if (!objects.some((object) => object.name === task.table)) throw new Error('Unknown table or view');
        const reference = `${q(schema)}.${q(task.table)}`;
        const columns = (await metadata(catalog.columns, [schema, task.table])).map((column) => ({
          ...column, nullable: column.nullable === true || column.nullable === 1 || column.nullable === 'YES',
          primaryKey: column.primaryKey === true || column.primaryKey === 1,
        }));
        if (task.action === 'inspect') {
          result = { columns, indexes: await metadata(catalog.indexes, [schema, task.table]),
            foreignKeys: await metadata(catalog.foreignKeys, [schema, task.table]) };
          if (engine === 'mysql') {
            const definition = await metadata(`SHOW CREATE ${objects.find((object) => object.name === task.table).type === 'view' ? 'VIEW' : 'TABLE'} ${reference}`);
            result.definition = definition[0]?.['Create Table'] ?? definition[0]?.['Create View'];
          } else result.definition = (await metadata(catalog.definition, [schema, task.table]))[0]?.definition;
        } else {
          const { limit, offset, direction } = pageOptions(task);
          for (const name of [task.sortColumn, task.filterColumn]) {
            if (name !== undefined && !columns.some((column) => column.name === name)) throw new Error('Unknown column');
          }
          const params = [];
          let where = '';
          if (task.filterColumn !== undefined) {
            if (task.filterValue === null) where = ` WHERE ${q(task.filterColumn)} IS NULL`;
            else { params.push(task.filterValue); where = ` WHERE ${q(task.filterColumn)}=${parameter(1)}`; }
          }
          const orderColumns = task.sortColumn ? [task.sortColumn] : columns.filter((column) => column.primaryKey).map((column) => column.name);
          const order = orderColumns.length ? ' ORDER BY ' + orderColumns.map((name) => `${q(name)} ${direction}`).join(', ') : engine === 'mssql' ? ' ORDER BY (SELECT NULL)' : '';
          params.push(limit + 1, offset);
          const pagination = engine === 'mssql'
            ? ` OFFSET ${parameter(params.length)} ROWS FETCH NEXT ${parameter(params.length - 1)} ROWS ONLY`
            : ` LIMIT ${parameter(params.length - 1)} OFFSET ${parameter(params.length)}`;
          result = await session.query(`SELECT * FROM ${reference}${where}${order}${pagination}`, params, limit + 1);
          result.hasMore = result.rows.length > limit;
          result.rows = result.rows.slice(0, limit);
          result.stableOrder = !task.sortColumn && orderColumns.length > 0;
        }
      }
    }
    if (engine !== 'mssql') await session.control('COMMIT');
    if (engine === 'mssql' && task.action === 'query') await session.commit();
    return result;
  } finally {
    await session.close();
  }
}
