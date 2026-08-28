import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StudentRichTextEditor from './StudentRichTextEditor';
import i18n from '../../i18n';

vi.mock('./RichTextEditor', () => ({
  default: ({ value, onChange, onBlur, onKeyDown, minHeight, ariaLabel }) => (
    <textarea
      aria-label={ariaLabel}
      data-min-height={minHeight}
      value={value}
      onChange={(event) => onChange({ html: event.target.value, plainText: event.target.value })}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  ),
}));

describe('StudentRichTextEditor', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
  });

  it('flushes a debounced draft before an Enter-to-submit handler runs', () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn(() => true);

    render(
      <StudentRichTextEditor
        value=""
        onChange={onChange}
        onChangeDebounceMs={120}
        onKeyDown={onKeyDown}
        ariaLabel="Chat message"
        showMathHint={false}
      />
    );

    const editor = screen.getByLabelText('Chat message');
    fireEvent.change(editor, { target: { value: '<p>Latest text</p>' } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: 'Enter' });

    const latestDraft = { html: '<p>Latest text</p>', plainText: '<p>Latest text</p>' };
    expect(onChange).toHaveBeenCalledWith(latestDraft);
    expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }), latestDraft);
  });

  it('passes the requested editor height through', () => {
    render(
      <StudentRichTextEditor
        value=""
        onChange={() => {}}
        minHeight={110}
        ariaLabel="Tall chat message"
        showMathHint={false}
      />
    );

    expect(screen.getByLabelText('Tall chat message')).toHaveAttribute('data-min-height', '110');
  });
});
