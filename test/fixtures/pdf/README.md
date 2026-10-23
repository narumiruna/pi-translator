# PDF test fixtures

These files contain original test text written for Pi Translator and are released under the repository's license.
They do not contain text or artwork copied from the Princeton acceptance document or another publication.

- `two-column.pdf` is a three-page text PDF with two columns, repeated page furniture, a split word, a URL, identifiers, and a formula.
- `encrypted.pdf` contains the same project-owned content and uses the test password `vibe-test`.
- `malformed.pdf` has a PDF signature but intentionally invalid document data.

The fixtures were generated with ReportLab and pypdf during development.
Runtime and test execution do not require either Python package.
