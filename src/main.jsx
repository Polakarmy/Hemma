import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import Politics from './Politics.jsx'
import ArticleDetails from './ArticleDetails.jsx'
import VoiceAssistant from './assistant/VoiceAssistant.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/politics" element={<Politics />} />
        <Route path="/article" element={<ArticleDetails />} />
      </Routes>
      <VoiceAssistant />
    </BrowserRouter>
  </StrictMode>,
)
