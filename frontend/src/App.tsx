import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { I18nProvider } from './i18n';
import { Sidebar } from './ui/Sidebar';
import { TopBar } from './ui/TopBar';
import { AIAndModels } from './views/AIAndModels';

export default function App() {
  return (
    <I18nProvider>
      <BrowserRouter>
        <div className="flex min-h-screen w-full">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar />
            <Routes>
              <Route path="/" element={<AIAndModels />} />
              <Route path="*" element={<AIAndModels />} />
            </Routes>
          </div>
        </div>
      </BrowserRouter>
    </I18nProvider>
  );
}