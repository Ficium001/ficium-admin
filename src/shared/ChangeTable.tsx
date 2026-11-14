/**
 * What a four-eyes request changes: Field | Now | After approval, frozen by
 * the server from the portal when the request was made. Shown to the person
 * who asked and the person approving, so nobody approves a label.
 */
export type ChangeRow = { field: string; before: string | null; after: string | null };
export type Described = { change?: { rows: ChangeRow[]; described?: boolean } | null };

export default function ChangeTable({ r, decided = false }: { r: Described; decided?: boolean }) {
  const rows = r.change?.rows ?? [];
  if (rows.length === 0) {
    return <p className="consequence" role="note">This request was made before changes were recorded. Check the record yourself before approving.</p>;
  }
  const isNew = rows.every((x) => x.before == null);
  return (
    <div className="change">
      <table>
        <thead><tr><th scope="col">Field</th>{!isNew && <th scope="col">{decided ? "Before" : "Now"}</th>}<th scope="col">{decided ? "After" : isNew ? "Will be" : "After approval"}</th></tr></thead>
        <tbody>{rows.map((x, i) => {
          const same = x.before === x.after;
          return (
            <tr key={i} className={same ? "same" : "changed"}>
              <th scope="row">{x.field}</th>
              {!isNew && <td>{x.before ?? "—"}</td>}
              <td>{same ? <span className="muted">{x.after ?? "—"} (unchanged)</span> : <strong>{x.after ?? "—"}</strong>}</td>
            </tr>
          );
        })}</tbody>
      </table>
      {!decided && <p className="hint">Read from the portal when the request was made. If the record changes before approval, approval is refused.</p>}
    </div>
  );
}
