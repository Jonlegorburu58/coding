# BWS Risk Portal (export & upload)

`BWS-Risk-Portal.html` is the whole portal in one file. Save it to your
laptop and open it in Edge. Nothing is installed.

1. In iManage Work (web), run a search under your own login (for example all
   documents in open matters) and export the results to Excel or CSV. Menu
   names vary by iManage version.
2. Open `BWS-Risk-Portal.html`, drop the export in, confirm the column and
   document-type suggestions, and the dashboard runs.
3. Optional: also export a matter/workspace list for partner, practice area,
   open date and key-date fields.

Your export is read in the browser tab only. It is not uploaded, not saved,
and the page cannot make network requests. Only your mapping settings are
remembered. "Clear data" empties the tab.

Rebuild with `npm run build:portal` in `dms-analytics/frontend`.
