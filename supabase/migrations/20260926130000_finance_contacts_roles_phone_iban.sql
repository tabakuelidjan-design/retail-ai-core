-- Contacts: declared roles + phone, first name and IBAN. ADDITIVE only (nullable / defaulted columns, nothing renamed or dropped).
--
-- Roles: a contact's role shown in Finance is the UNION of
--   - its declared roles (chosen by the merchant when creating / editing the contact: customer, supplier, or both), and
--   - its roles derived from real documents (an issued sales document => customer; a linked supplier invoice => supplier).
-- A declared role can be removed only while no document supports it (enforced by the application, see contacts.js roleChangeProblems):
-- a contact with customer invoices can never silently stop being a customer.
-- Still ONE table for customers and suppliers (fin_companies): no second contacts / clients / suppliers table.

alter table fin_companies add column declared_customer boolean not null default false;
alter table fin_companies add column declared_supplier boolean not null default false;
alter table fin_companies add column first_name text;   -- individuals only: first name + name (the name column holds the last name)
alter table fin_companies add column phone text;
alter table fin_companies add column iban text;         -- checked with the ISO 13616 mod-97 rule before it is stored
