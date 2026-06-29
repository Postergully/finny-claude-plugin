import { describe, it, expect } from 'vitest';
import { sanitizeSuiteQL, SuiteQLViolation } from './suiteql-guard.js';

describe('sanitizeSuiteQL', () => {
  // The six canonical cases from plan L922-930.
  it('allows SELECT', () =>
    expect(sanitizeSuiteQL('SELECT id FROM transaction')).toMatch(/SELECT/));

  it('rejects DROP', () => expect(() => sanitizeSuiteQL('DROP TABLE x')).toThrow(SuiteQLViolation));

  it('rejects DELETE', () =>
    expect(() => sanitizeSuiteQL('DELETE FROM x')).toThrow(SuiteQLViolation));

  it('rejects UPDATE', () =>
    expect(() => sanitizeSuiteQL('UPDATE x SET y=1')).toThrow(SuiteQLViolation));

  it('rejects multi-statement', () =>
    expect(() => sanitizeSuiteQL('SELECT 1; SELECT 2')).toThrow(SuiteQLViolation));

  it('rejects comment injection', () =>
    expect(() => sanitizeSuiteQL('SELECT 1 -- DROP')).toThrow(SuiteQLViolation));

  // Verifier-rubric expansion: case-insensitive coverage of every
  // forbidden verb listed in the guard.
  it.each([
    ['drop', 'drop table foo'],
    ['Drop', 'Drop table foo'],
    ['DROP', 'DROP TABLE foo'],
    ['delete', 'delete from foo'],
    ['DELETE', 'DELETE FROM foo'],
    ['update', 'update foo set x=1'],
    ['UPDATE', 'UPDATE foo SET x=1'],
    ['insert', 'insert into foo values (1)'],
    ['INSERT', 'INSERT INTO foo VALUES (1)'],
    ['truncate', 'truncate table foo'],
    ['TRUNCATE', 'TRUNCATE TABLE foo'],
    ['alter', 'alter table foo add col x int'],
    ['ALTER', 'ALTER TABLE foo ADD col x INT'],
    ['create', 'create table foo (x int)'],
    ['CREATE', 'CREATE TABLE foo (x INT)'],
    ['grant', 'grant select on foo to bar'],
    ['GRANT', 'GRANT SELECT ON foo TO bar'],
    ['revoke', 'revoke select on foo from bar'],
    ['REVOKE', 'REVOKE SELECT ON foo FROM bar'],
    ['exec', 'exec sp_dosomething'],
    ['EXEC', 'EXEC sp_dosomething'],
  ])('rejects forbidden keyword %s case-insensitive', (_label, sql) => {
    expect(() => sanitizeSuiteQL(sql)).toThrow(SuiteQLViolation);
  });

  // Comment/separator coverage.
  it('rejects /* block comment */', () =>
    expect(() => sanitizeSuiteQL('SELECT 1 /* hidden */')).toThrow(SuiteQLViolation));

  it('rejects trailing semicolon', () =>
    expect(() => sanitizeSuiteQL('SELECT 1 FROM x;')).toThrow(SuiteQLViolation));

  // Statement-leader: a query starting with neither SELECT nor WITH must
  // be rejected even if it contains no forbidden keyword or comment.
  it('rejects non-SELECT/WITH leader', () =>
    expect(() => sanitizeSuiteQL('SHOW TABLES')).toThrow(SuiteQLViolation));

  it('allows WITH (CTE)', () =>
    expect(sanitizeSuiteQL('WITH t AS (SELECT id FROM transaction) SELECT * FROM t')).toMatch(
      /^WITH/
    ));

  // Error-message confidentiality: full query content must NOT leak in
  // the error message beyond the first 80 characters.
  it('does not leak query content beyond first 80 chars', () => {
    const longSql =
      'DROP TABLE very_secret_table_name_with_pii_and_internal_metadata_that_should_not_leak_anywhere';
    expect(longSql.length).toBeGreaterThan(80);
    try {
      sanitizeSuiteQL(longSql);
      throw new Error('expected SuiteQLViolation');
    } catch (err) {
      expect(err).toBeInstanceOf(SuiteQLViolation);
      const message = (err as SuiteQLViolation).message;
      // The message includes at most the first 80 chars of the input.
      // The portion of the input beyond char 80 must NOT appear.
      const tail = longSql.slice(80);
      expect(message).not.toContain(tail);
    }
  });
});
