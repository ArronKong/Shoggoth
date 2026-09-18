import { Fragment, type ReactNode } from 'react';
import type { InspirationAttachment } from '../types';
import InspirationMediaPreview from './InspirationMediaPreview';
import { inspirationContentParts } from './inspiration-content';

export default function InspirationContent({ body, attachments = [], compact, onOpen, renderText }: {
  body: string; attachments?: InspirationAttachment[]; compact?: boolean; onOpen?: () => void;
  renderText: (text: string, index: number) => ReactNode;
}) {
  return <>{inspirationContentParts({ body, attachments }).map((part, index) => part.kind === 'text'
    ? <Fragment key={`text:${part.key}`}>{renderText(part.text, index)}</Fragment>
    : <InspirationMediaPreview key={`media:${part.key}`} attachments={part.attachments} compact={compact} onOpen={onOpen} />)}</>;
}
