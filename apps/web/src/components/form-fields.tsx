'use client';

import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface FieldFrameProps {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  /** Receives the ids that tie the label, hint and error to the control. */
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label + control + hint + error, wired for screen readers (`aria-describedby`, `aria-invalid`). */
function FieldFrame({ label, error, hint, children }: FieldFrameProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children({ id, describedBy: describedBy || undefined, invalid: Boolean(error) })}
      {hint ? (
        <p id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type InputProps = Omit<ComponentProps<typeof Input>, 'id'>;

export interface TextFieldProps extends InputProps {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  /** Keep the value left-to-right inside right-to-left text (emails, codes). */
  isolate?: boolean;
}

/** A text input with its label and error. Works with `register()` of react-hook-form (ref is a prop). */
export function TextField({ label, error, hint, isolate, className, ...props }: TextFieldProps) {
  return (
    <FieldFrame label={label} error={error} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <Input
          id={id}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn('h-10 text-base md:text-sm', isolate && 'ltr-isolate', className)}
          {...props}
        />
      )}
    </FieldFrame>
  );
}

/** A password input with a show/hide button. */
export function PasswordField({ label, error, hint, className, ...props }: TextFieldProps) {
  const t = useTranslations('Common');
  const [visible, setVisible] = useState(false);
  return (
    <FieldFrame label={label} error={error} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <div className="relative">
          <Input
            id={id}
            type={visible ? 'text' : 'password'}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className={cn('ltr-isolate h-10 pe-11 text-base md:text-sm', className)}
            {...props}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute inset-e-0.5 top-1/2 size-9 -translate-y-1/2"
            aria-label={visible ? t('hidePassword') : t('showPassword')}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </Button>
        </div>
      )}
    </FieldFrame>
  );
}

export interface SelectFieldProps extends Omit<ComponentProps<'select'>, 'id'> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}

/**
 * A native `<select>`: the right control on a phone (the system picker), keyboard and screen-reader friendly,
 * and it follows the page direction on its own.
 */
export function SelectField({
  label,
  error,
  hint,
  className,
  children,
  ...props
}: SelectFieldProps) {
  return (
    <FieldFrame label={label} error={error} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn(
            'border-input bg-background h-10 w-full rounded-lg border px-2.5 text-base md:text-sm',
            'focus-visible:border-ring focus-visible:ring-ring/50 outline-none focus-visible:ring-3',
            'aria-invalid:border-destructive disabled:opacity-50',
            className,
          )}
          {...props}
        >
          {children}
        </select>
      )}
    </FieldFrame>
  );
}

/** A checkbox with its label on the same line. */
export function CheckboxField({
  label,
  className,
  ...props
}: Omit<ComponentProps<'input'>, 'id' | 'type'> & { label: string }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="checkbox"
        className={cn('size-4 accent-current', className)}
        {...props}
      />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

/** Submit button that shows progress and ignores a second click while the request runs. */
export function SubmitButton({
  pending,
  children,
  className,
  disabled,
  ...props
}: ComponentProps<typeof Button> & { pending: boolean }) {
  return (
    <Button
      type="submit"
      size="lg"
      className={cn('h-10 w-full text-base md:text-sm', className)}
      {...props}
      disabled={pending || disabled}
      aria-busy={pending}
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </Button>
  );
}
