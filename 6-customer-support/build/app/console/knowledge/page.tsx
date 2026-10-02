import { canSeeEvaluations } from '../../../lib/auth.ts';
import { requireConsoleUser } from '../../../lib/console-session.ts';
import { listArticles } from '../../../lib/kb/articles.ts';
import { KnowledgeForm, RetireArticle } from '../../ui/knowledge-form.tsx';
import { Pill } from '../../ui/pill.tsx';
import { utc } from '../../ui/format.ts';

/** Admins add approved answers the agent can search, alongside the help centre file. */
export default async function Knowledge() {
  const user = await requireConsoleUser('/console/knowledge');
  if (!canSeeEvaluations(user)) return (
    <>
      <h1>Knowledge base</h1>
      <p className="rp-lede">The knowledge base is managed by admins. Ask an admin to add or change an article.</p>
    </>
  );
  const { articles, fileChunks } = await listArticles();
  const live = articles.filter((a) => !a.retired).length;
  return (
    <>
      <div className="rp-page-head"><h1>Knowledge base</h1>
        <p>{fileChunks} sections from the help centre file, {live} {live === 1 ? 'article' : 'articles'} added here</p></div>

      <details className="rp-run rp-run-form" open={articles.length === 0}>
        <summary><span className="rp-run-title">Add an article</span><span className="rp-run-meta">An approved answer the agent can search on calls and chats</span></summary>
        <div className="rp-run-body"><KnowledgeForm /></div>
      </details>

      <h2>Added in the console</h2>
      {articles.length === 0 ? <p className="rp-lede">None yet. Articles you add show here, and the agent searches them with the help centre.</p> : (
        <div className="rp-table-wrap"><table className="rp-table">
          <thead><tr><th>Title</th><th>Answer</th><th>Updated</th><th>Status</th></tr></thead>
          <tbody>{articles.map((a) => (
            <tr key={a.id}>
              <td>{a.heading}</td><td className="rp-clip">{a.content}</td><td>{utc(a.updated_at)}</td>
              <td>{a.retired ? <Pill value="closed" label="Retired" /> : <div className="rp-actions"><Pill value="resolved" label="Live" /><RetireArticle id={a.id} heading={a.heading} /></div>}</td>
            </tr>))}
          </tbody></table></div>
      )}
    </>
  );
}
