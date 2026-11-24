import { MailCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';

/** The frame of every auth page: a title, an optional description and the content. */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="w-full">
      <CardHeader>
        <h1 className="text-xl leading-snug font-semibold">{title}</h1>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
      {footer ? (
        <div className="text-muted-foreground px-4 pb-4 text-center text-sm">{footer}</div>
      ) : null}
    </Card>
  );
}

/** "Check your inbox": the same screen whether or not the address has an account (no enumeration). */
export function InboxNotice({ title, body }: { title: string; body: string }) {
  return (
    <div role="status" className="grid justify-items-center gap-3 py-4 text-center">
      <MailCheck className="text-primary size-10" aria-hidden />
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{body}</p>
    </div>
  );
}
