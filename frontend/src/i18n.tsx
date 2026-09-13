import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Locale = 'ar' | 'en';

const dict = {
  ar: {
    'app.name': 'KIP',
    'app.tagline': 'معرفة — ذكاء — مشاريع',
    'nav.home': 'الرئيسية',
    'nav.projects': 'المشاريع',
    'nav.knowledge': 'المعرفة',
    'nav.skills': 'المهارات',
    'nav.ai': 'الذكاء الاصطناعي',
    'nav.users': 'المستخدمون',
    'nav.integrations': 'التكاملات',
    'nav.reports': 'التقارير',
    'nav.settings': 'الإعدادات',
    'pro.title': 'KIP Pro',
    'pro.subtitle': 'مساحة الذكاء الاصطناعي الخاصة بك',
    'pro.progress': '2 من 5 مشاريع',
    'pro.upgrade': 'ترقية',
    'topbar.search': 'ابحث في أي شيء…',
    'topbar.searchHint': '⌘K',
    'topbar.admin': 'مدير النظام',
    'topbar.notifications': 'التنبيهات',
    'page.title': 'الذكاء الاصطناعي والنماذج',
    'page.subtitle': 'أدر مزوّدي الذكاء الاصطناعي، وكنّوفك النماذج، وتحكّم في استخدام KIP للذكاء عبر مشاريعك.',
    'page.docs': 'عرض التوثيق',
    'tab.overview': 'نظرة عامة',
    'tab.providers': 'المزوّدون',
    'tab.assignment': 'تعيين النماذج',
    'tab.usage': 'الاستخدام والتكاليف',
    'tab.settings': 'الإعدادات',
    'providers.title': 'مزوّدو الذكاء الاصطناعي',
    'providers.subtitle': 'اربط مزوّديك وتحكّم في اتصالاتهم.',
    'providers.add': '+ إضافة مزوّد',
    'provider.openrouter.tagline': 'بوابة واحدة لنماذج متعددة.',
    'provider.openai.tagline': 'مستوحاة من خلال OpenRouter.',
    'provider.anthropic.tagline': 'مستوحاة من خلال OpenRouter.',
    'provider.google.tagline': 'مستوحاة من خلال OpenRouter.',
    'provider.availableVia': 'متاح عبر OpenRouter',
    'provider.connectShort': 'ربط',
    'provider.testing': 'اختبار…',
    'provider.revoke': 'إبطال الاعتماد',
    'provider.saved': 'تم الحفظ',
    'provider.apiKeyPlaceholder': 'أدخل مفتاح OpenRouter',
    'provider.required': 'مفتاح API مطلوب',
    'provider.authRequired': 'الوصول يحتاج توثيق المسؤول.',
    'provider.errorUnknown': 'حدث خطأ غير متوقع.',
    'status.connected': 'متصل',
    'status.not_connected': 'غير متصل',
    'status.issue': 'مشكلة',
    'provider.apiKey': 'مفتاح API',
    'provider.modelsAvailable': ' نموذجًا متاحًا',
    'provider.lastChecked': 'آخر فحص',
    'provider.test': 'اختبار الاتصال',
    'provider.manage': 'إدارة',
    'provider.connect': 'ربط المزوّد',
    'assignment.title': 'تعيين النموذج',
    'assignment.subtitle': 'اختر أفضل نموذج لكل نوع من المهام',
    'assignment.save': 'حفظ',
    'assignment.saved': 'تم الحفظ',
    'assignment.saving': 'جارٍ الحفظ…',
    'assignment.loading': 'جارٍ التحميل…',
    'assignment.selectModel': 'اختر نموذجًا…',
    'assignment.saveChanges': 'حفظ التغييرات',
    'assignment.clear': 'إلغاء التعيين',
    'assignment.catalogUnavailable': 'تعذر تحميل نماذج OpenRouter — تأكد من ربط المزوّد.',
    'workload.source_analysis': 'تحليل المصادر',
    'workload.desc.source_analysis': 'قراءة وفهم الوثائق والمصادر.',
    'workload.chat_assistant': 'المحادثة والمساعد',
    'workload.desc.chat_assistant': 'الردود والحوار مع المستخدم.',
    'workload.vision_scan': 'المسح الذكي / الرؤية',
    'workload.desc.vision_scan': 'تحليل الصور والمحتوى المرئي.',
    'workload.summarization': 'التلخيص',
    'workload.desc.summarization': 'تلخيص النصوص الطويلة.',
    'workload.embeddings': 'التضمين والبحث الدلالي',
    'workload.desc.embeddings': 'توليد التضمينات للبحث الدلالي.',
    'assignment.recommended': 'موصى به',
    'usage.title': 'الاستخدام والتكاليف',
    'usage.last30': 'آخر 30 يومًا',
    'usage.totalCalls': 'إجمالي الاستدعاءات',
    'usage.totalTokens': 'إجمالي الرموز',
    'usage.totalCost': 'إجمالي التكلفة (USD)',
    'usage.errorRate': 'معدل الأخطاء',
    'usage.tokens': 'الرموز',
    'usage.tooltipDate': 'الرموز: {tokens}',
    'activity.title': 'النشاط الأخير',
    'activity.viewAll': 'عرض الكل',
    'activity.colTime': 'الوقت',
    'activity.colAction': 'الإجراء',
    'activity.colProvider': 'المزوّد',
    'activity.colDetails': 'التفاصيل',
    'activity.colStatus': 'الحالة',
    'activity.twoMin': 'قبل دقيقتين',
    'activity.oneHour': 'قبل ساعة',
    'activity.threeHours': 'قبل 3 ساعات',
    'activity.oneDay': 'قبل يوم',
    'activity.connTest': 'اختبار اتصال',
    'activity.connOk': 'تم الاتصال بنجاح',
    'activity.modelUpdated': 'تحديث نموذج',
    'activity.chatModel': 'تم تعيين نموذج المحادثة إلى gpt-4o-mini',
    'activity.providerAdded': 'إضافة مزوّد',
    'activity.providerConfigured': 'تم تكوين المزوّد',
    'activity.sourceModel': 'تم تعيين نموذج تحليل المصادر',
    'status.success': 'نجاح',
    'status.info': 'معلومة',
  },
  en: {
    'app.name': 'KIP',
    'app.tagline': 'Knowledge — Intelligence — Projects',
    'nav.home': 'Home',
    'nav.projects': 'Projects',
    'nav.knowledge': 'Knowledge',
    'nav.skills': 'Skills',
    'nav.ai': 'AI & Models',
    'nav.users': 'Users',
    'nav.integrations': 'Integrations',
    'nav.reports': 'Reports',
    'nav.settings': 'Settings',
    'pro.title': 'KIP Pro',
    'pro.subtitle': 'Your AI workspace',
    'pro.progress': '2 of 5 projects',
    'pro.upgrade': 'Upgrade',
    'topbar.search': 'Search anything…',
    'topbar.searchHint': '⌘K',
    'topbar.admin': 'System Admin',
    'topbar.notifications': 'Notifications',
    'page.title': 'AI & Models',
    'page.subtitle': 'Manage AI providers, configure models, and control how KIP uses AI across your projects.',
    'page.docs': 'View Documentation',
    'tab.overview': 'Overview',
    'tab.providers': 'Providers',
    'tab.assignment': 'Model Assignment',
    'tab.usage': 'Usage & Costs',
    'tab.settings': 'Settings',
    'providers.title': 'AI Providers',
    'providers.subtitle': 'Connect your providers and control their connections.',
    'providers.add': '+ Add Provider',
    'provider.openrouter.tagline': 'One gateway, many models.',
    'provider.openai.tagline': 'Available through OpenRouter.',
    'provider.anthropic.tagline': 'Available through OpenRouter.',
    'provider.google.tagline': 'Available through OpenRouter.',
    'provider.availableVia': 'Available via OpenRouter',
    'provider.connectShort': 'Connect',
    'provider.testing': 'Testing…',
    'provider.revoke': 'Revoke',
    'provider.saved': 'Saved',
    'provider.apiKeyPlaceholder': 'Enter OpenRouter API key',
    'provider.required': 'An API key is required',
    'provider.authRequired': 'Admin authentication required.',
    'provider.errorUnknown': 'An unexpected error occurred.',
    'status.connected': 'Connected',
    'status.not_connected': 'Not Connected',
    'status.issue': 'Issue',
    'provider.apiKey': 'API Key',
    'provider.modelsAvailable': ' models available',
    'provider.lastChecked': 'Last checked',
    'provider.test': 'Test Connection',
    'provider.manage': 'Manage',
    'provider.connect': 'Connect Provider',
    'assignment.title': 'Model Assignment',
    'assignment.subtitle': 'Choose the best model for each task type',
    'assignment.save': 'Save',
    'assignment.saved': 'Saved',
    'assignment.saving': 'Saving…',
    'assignment.loading': 'Loading…',
    'assignment.selectModel': 'Select model…',
    'assignment.saveChanges': 'Save changes',
    'assignment.clear': 'Clear assignment',
    'assignment.catalogUnavailable': 'Could not load OpenRouter models — check that the provider is connected.',
    'workload.source_analysis': 'Source Analysis',
    'workload.desc.source_analysis': 'Read and understand documents and sources.',
    'workload.chat_assistant': 'Chat & Assistant',
    'workload.desc.chat_assistant': 'Replies and conversation with the user.',
    'workload.vision_scan': 'Smart Scan / Vision',
    'workload.desc.vision_scan': 'Analyze images and visual content.',
    'workload.summarization': 'Summarization',
    'workload.desc.summarization': 'Summarize long texts.',
    'workload.embeddings': 'Embeddings',
    'workload.desc.embeddings': 'Generate embeddings for semantic search.',
    'assignment.recommended': 'Recommended',
    'usage.title': 'Usage & Costs',
    'usage.last30': 'Last 30 days',
    'usage.totalCalls': 'Total Calls',
    'usage.totalTokens': 'Total Tokens',
    'usage.totalCost': 'Total Cost (USD)',
    'usage.errorRate': 'Error Rate',
    'usage.tokens': 'Tokens',
    'usage.tooltipDate': 'Tokens: {tokens}',
    'activity.title': 'Recent Activity',
    'activity.viewAll': 'View All',
    'activity.colTime': 'Time',
    'activity.colAction': 'Action',
    'activity.colProvider': 'Provider',
    'activity.colDetails': 'Details',
    'activity.colStatus': 'Status',
    'activity.twoMin': '2 minutes ago',
    'activity.oneHour': '1 hour ago',
    'activity.threeHours': '3 hours ago',
    'activity.oneDay': '1 day ago',
    'activity.connTest': 'Connection test',
    'activity.connOk': 'Successfully connected',
    'activity.modelUpdated': 'Model updated',
    'activity.chatModel': 'Chat model set to gpt-4o-mini',
    'activity.providerAdded': 'Provider added',
    'activity.providerConfigured': 'Provider configured',
    'activity.sourceModel': 'Source analysis model set',
    'status.success': 'Success',
    'status.info': 'Info',
  },
} as const;

type Dict = (typeof dict)['ar'];

interface I18nCtx {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  toggle: () => void;
  t: (key: string, vars?: Record<string, string>) => string;
}

const Ctx = createContext<I18nCtx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>('ar');
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = locale;
  }, [dir, locale]);

  const SRCO: Record<string, string> = dict.ar;
  const EN: Record<string, string> = dict.en as unknown as Record<string, string>;
  const dicts: Record<string, Record<string, string>> = { ar: SRCO, en: EN };

  const value = useMemo<I18nCtx>(() => {
    const src = dicts[locale];
    return {
      locale,
      dir,
      toggle: () => setLocale((l) => (l === 'ar' ? 'en' : 'ar')),
      t: (key, vars) => {
        let s: string = src[key] ?? EN[key] ?? String(key);
        if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
        return s;
      },
    };
  }, [locale, dir, EN, dicts]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}