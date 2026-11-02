// This lexer only identifies unsafe statement controls; the server validates SQL syntax.
function sqlTokens(sql, dialect) {
  const tokens = [];
  for (let index = 0; index < sql.length;) {
    const rest = sql.slice(index);
    const comment = rest.match(dialect === 'mysql' ? /^--(?=[\u0000-\u0020]|$)[^\r\n]*/u : /^--[^\r\n]*/u) ||
      (dialect === 'mysql' && rest.match(/^#[^\r\n]*/u));
    if (comment) { index += comment[0].length; continue; }
    if (rest.startsWith('/*')) {
      if (dialect === 'mysql' && /^\/\*[!+]/u.test(rest)) throw new Error('Executable MySQL comments are unsupported in migrations.');
      let depth = 1;
      index += 2;
      while (index < sql.length && depth) {
        if (dialect === 'postgres' && sql.slice(index, index + 2) === '/*') { depth++; index += 2; }
        else if (sql.slice(index, index + 2) === '*/') { depth--; index += 2; }
        else index++;
      }
      if (depth) throw new Error('Unterminated SQL comment.');
      continue;
    }
    const dollar = dialect === 'postgres' && rest.match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u);
    if (dollar) {
      const end = sql.indexOf(dollar[0], index + dollar[0].length);
      if (end < 0) throw new Error('Unterminated PostgreSQL dollar quote.');
      tokens.push('<quoted>'); index = end + dollar[0].length; continue;
    }
    const quote = sql[index];
    if ("'\"`[".includes(quote)) {
      const close = quote === '[' ? ']' : quote;
      const escapes = (dialect === 'mysql' && (quote === "'" || quote === '"')) || (dialect === 'postgres' && quote === "'" && /(?:^|\W)E$/iu.test(sql.slice(0, index)));
      index++;
      let closed = false;
      while (index < sql.length) {
        if (escapes && sql[index] === '\\') { index += 2; continue; }
        if (sql[index++] === close) {
          if (sql[index] === close) { index++; continue; }
          closed = true; break;
        }
      }
      if (!closed) throw new Error('Unterminated SQL quote.');
      tokens.push('<quoted>'); continue;
    }
    const word = rest.match(/^[A-Za-z_][A-Za-z_0-9]*/u);
    if (word) { tokens.push(word[0].toUpperCase()); index += word[0].length; continue; }
    if (!/\s/u.test(quote)) tokens.push(quote);
    index++;
  }
  return tokens;
}

export function validateMigrationSql(sql, dialect) {
  let statement = [], trigger = false;
  const inspect = () => {
    if (!statement.length) return;
    const [first] = statement;
    const createsTrigger = first === 'CREATE' && (statement[1] === 'TRIGGER' ||
      (['TEMP', 'TEMPORARY'].includes(statement[1]) && statement[2] === 'TRIGGER'));
    if (dialect === 'sqlite' && createsTrigger) trigger = true;
    const triggerEnd = dialect === 'sqlite' && trigger && first === 'END';
    if (triggerEnd) trigger = false;
    if ((!triggerEnd && /^(BEGIN|START|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|XA)$/u.test(first)) ||
        first === 'SET' ||
        (first === 'PREPARE' && statement[1] === 'TRANSACTION') ||
        (dialect === 'postgres' && first === 'RESET') ||
        /^(LOCK|UNLOCK)$/u.test(first)) {
      throw new Error('Migration transaction controls are unsupported; the coordinator owns transactions.');
    }
    if (/^(DELIMITER|SOURCE|USE|CONNECT|DISCONNECT|GO)$/u.test(first) || first === '\\' || first === '.') {
      throw new Error('Client directives are unsupported in migrations.');
    }
    if (statement.includes('\\')) throw new Error('Client directives are unsupported in migrations.');
  };
  for (const token of [...sqlTokens(sql, dialect), ';']) {
    if (token === ';') { inspect(); statement = []; }
    else statement.push(token);
  }
}
