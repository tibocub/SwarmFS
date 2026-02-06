
let RawDatabase;
const isBun = typeof globalThis.Bun !== "undefined";

if (isBun) {
  const { Database } = await import("bun:sqlite");
  RawDatabase = Database;
} else {
  const { default: BetterSqlite3 } = await import("better-sqlite3");
  RawDatabase = BetterSqlite3;
}

class Database {
  constructor(filename) {
    this.db = new RawDatabase(filename);
  }

  // --- Normalize PRAGMA ---
  pragma(str) {
    if (isBun) {
      // Bun runs pragmas as normal SQL
      return this.db.exec(`PRAGMA ${str}`);
    } else {
      return this.db.pragma(str);
    }
  }

  // --- Normalize prepare ---
  prepare(sql) {
    const stmt = this.db.prepare(sql);

    if (!isBun) return stmt; // better-sqlite3 already perfect

    // Bun statements differ slightly; normalize common helpers
    return {
      run: (...args) => stmt.run(...args),
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
    };
  }

  // --- Normalize exec ---
  exec(sql) {
    return this.db.exec(sql);
  }

  // --- Normalize transactions ---
  transaction(fn) {
    if (!isBun) return this.db.transaction(fn);

    // Manual transaction wrapper for Bun
    return (...args) => {
      try {
        this.db.exec("BEGIN");
        const result = fn(...args);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    };
  }

  close() {
    this.db.close();
  }
}

export { Database };
