import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

const field =
  "w-full rounded-sm border border-border bg-surface-2 px-3 text-[15px] text-fg placeholder:text-fg-3 outline-none transition-[border-color,box-shadow] duration-[120ms] focus:border-brand focus:shadow-[0_0_0_3px_var(--brand-tint)] aria-[invalid=true]:border-danger";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(field, "h-10", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(field, "min-h-24 py-2", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return <select ref={ref} className={cn(field, "h-10", className)} {...props} />;
});

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-small font-medium text-fg">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-caption text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-caption text-fg-3">{hint}</p>
      ) : null}
    </div>
  );
}
