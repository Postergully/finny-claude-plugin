import { describe, it, expect } from 'vitest';
import { detectDestructiveIntent } from '../../../../mcp/tools/_shared/destructiveIntentGuard.js';

describe('detectDestructiveIntent', () => {
  describe('trips on verb + NetSuite entity', () => {
    const shouldTrip = [
      'Delete all overdue vendor bills from last quarter.',
      'delete vendor bills',
      'Drop all transactions for vendor Acme.',
      'Remove the invoice with ID 12345.',
      'Purge old purchase orders.',
      'Wipe these vendor records.',
      'Void all outstanding payments for this customer.',
      'Cancel these POs immediately.',
      'Write off those bills.',
      'write-off the overdue invoices',
      'TRUNCATE JOURNAL ENTRIES',
      'erase employee records',
    ];
    for (const q of shouldTrip) {
      it(`trips: "${q}"`, () => {
        const m = detectDestructiveIntent(q);
        expect(m).not.toBeNull();
      });
    }
  });

  describe('does NOT trip on softer / read-only phrasings', () => {
    const shouldNotTrip = [
      // Verb without a NetSuite entity
      'Delete this line from your last response.',
      'Remove the extra whitespace in your answer.',
      'Cancel the thinking — just give me the answer.',
      // NetSuite entity without a destructive verb
      'Show me open vendor bills for last quarter.',
      'List all overdue invoices.',
      'What is the balance for vendor Acme?',
      'Archive old vendor bills from last quarter.', // scenario 07b
      'Close out the month-end review.', // `close out` + no entity
      'Review vendor payments.',
      'Count the purchase orders placed last week.',
      // Neither
      'Hello, how are you?',
      'What is 2+2?',
    ];
    for (const q of shouldNotTrip) {
      it(`does not trip: "${q}"`, () => {
        const m = detectDestructiveIntent(q);
        expect(m).toBeNull();
      });
    }
  });

  it('returns the matched verb and entity', () => {
    const m = detectDestructiveIntent('Delete all overdue vendor bills from last quarter.');
    expect(m?.verb).toBe('delete');
    // `vendor` matches before `vendor bills` because the verb list order is
    // scanned first; the entity list finds whichever is earliest. Either
    // "vendor" or "vendor bills" or "bill" is acceptable as the first match
    // depending on list order — the important property is `entity` is truthy.
    expect(m?.entity).toBeTruthy();
  });

  it('is case-insensitive', () => {
    expect(detectDestructiveIntent('DELETE VENDOR BILLS')).not.toBeNull();
    expect(detectDestructiveIntent('delete vendor bills')).not.toBeNull();
    expect(detectDestructiveIntent('Delete Vendor Bills')).not.toBeNull();
  });
});
