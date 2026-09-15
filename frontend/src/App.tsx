import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { I18nProvider } from './i18n';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ProjectProvider } from './contexts/ProjectContext';
import { ProtectedShell } from './components/ProtectedShell';
import { LoginPage } from './pages/LoginPage';
import { AIAndModels } from './views/AIAndModels';
import { Knowledge } from './views/Knowledge';
import { TestsConsole } from './views/TestsConsole';

function Router() {
  const { session, initializing } = useAuth();

  if (initializing) {
    return <div className="flex min-h-screen items-center justify-center text-muted-soft">…</div>;
  }
  if (!session) {
    return <LoginPage />;
  }
  return (
    <ProjectProvider>
      <ProtectedShell>
        <Routes>
          <Route path="/" element={<AIAndModels />} />
          <Route path="/ai-models" element={<AIAndModels />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/tests" element={<TestsConsole />} />
          <Route path="*" element={<AIAndModels />} />
        </Routes>
      </ProtectedShell>
    </ProjectProvider>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <BrowserRouter>
        <AuthProvider>
          <Router />
        </AuthProvider>
      </BrowserRouter>
    </I18nProvider>
  );
}