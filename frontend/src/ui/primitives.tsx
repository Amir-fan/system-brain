import type { ReactNode } from 'react';
import { useI18n } from '../i18n';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl2 border border-surface-line bg-surface-card shadow-card ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4">
      <div>
        <h3 className="text-lg font-semibold text-slate-800">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-sm text-muted-soft">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: 'success' | 'neutral' | 'brand';
  children: ReactNode;
}) {
  const tones = {
    success: 'bg-success-100 text-success-700',
    neutral: 'bg-slate-100 text-muted',
    brand: 'bg-brand-50 text-brand-700',
  } as const;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Button({
  variant = 'default',
  children,
  onClick,
  className = '',
  disabled = false,
  title,
}: {
  variant?: 'default' | 'primary' | 'ghost' | 'outline';
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const variants = {
    default: 'bg-white text-slate-700 border border-surface-line hover:bg-slate-50',
    primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
    ghost: 'text-muted hover:text-slate-800 hover:bg-slate-100',
    outline: 'border border-surface-line text-slate-700 hover:bg-slate-50',
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Dot({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${className}`} />;
}