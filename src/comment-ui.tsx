interface CommentComposerProps {
  draft: string;
  error: string | null;
  sending: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSend: () => void;
}

export function CommentComposer({
  draft,
  error,
  sending,
  onChange,
  onCancel,
  onSend,
}: CommentComposerProps) {
  return (
    <div className="comment-composer">
      <div className="comment-composer-header">Comment on selection</div>
      <textarea
        className="comment-composer-input"
        placeholder="Ask about this element or describe the change you want"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
      />
      {error && <div className="comment-composer-error">{error}</div>}
      <div className="comment-composer-actions">
        <button className="app-button" type="button" onClick={onCancel} disabled={sending}>
          Cancel
        </button>
        <button
          className="app-button comment-send-button"
          type="button"
          onClick={onSend}
          disabled={sending || !draft.trim()}
        >
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
    </div>
  );
}
