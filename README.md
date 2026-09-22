# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.
# 🤖 REZE — Desktop AI Assistant

REZE is an experimental desktop AI assistant for Windows, built with Electron, React and Node.js.

The goal is to create an assistant that can understand natural voice commands, interact with desktop applications, browse the web, control media, manage files and execute actions directly on the computer.

> 🚧 **Work in Progress**
>
> REZE is currently under active development.  
> Some features are experimental, incomplete or may change significantly between versions.

## ✨ Technologies

- Electron
- React
- Node.js
- Gemini Live API
- Groq API
- Ollama
- Qwen
- openWakeWord
- Playwright
- Windows UI Automation
- PowerShell
- Python

## 🚀 Features

- 🎙️ Natural voice commands
- 🧠 Local + cloud AI architecture
- ⚡ Gemini Live for real-time voice understanding
- 🗣️ Local wake word detection
- 💻 Windows application control
- 🖱️ Mouse and keyboard automation
- 🌐 Browser automation
- 🎵 YouTube Music control
- 📁 File reading, searching and editing
- ⚙️ PowerShell integration
- 🧠 Local AI through Ollama / Qwen
- 🔄 Automatic switching between local AI models
- 🛡️ Confirmation system for potentially destructive actions
- 🧩 Tool/function calling architecture

## 🧠 How It Works

REZE uses different AI systems depending on the task.

### Voice

```text
Microphone
    ↓
Local Wake Word ("REZE")
    ↓
Gemini Live
    ↓
Intent / Tool Call
    ↓
REZE Tools
    ↓
Windows / Browser / Files / Media
