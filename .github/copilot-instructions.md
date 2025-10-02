<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->

## 3Speak Modern Video Encoder Project

This is a modern, reliable replacement for the 3Speak video encoder with full API compatibility.

### Key Requirements:
- Node.js/TypeScript for clean, maintainable code
- Full compatibility with existing 3Speak gateway APIs
- Multi-quality video encoding (1080p, 720p, 480p)  
- HLS streaming output with .m3u8 playlists
- FFmpeg integration with hardware acceleration fallback
- IPFS file storage integration
- DID-based authentication system
- Easy deployment and setup

### Progress Checklist:
- [x] ✅ Verified copilot-instructions.md file created
- [x] ✅ Clarify Project Requirements (COMPLETED - 3Speak encoder specified)
- [x] ✅ Scaffold the Project (TypeScript structure, package.json, core services)
- [x] ✅ Customize the Project (Gateway client, video processor, IPFS service, identity management)
- [x] ✅ Install Required Extensions (No specific extensions needed)
- [x] ✅ Compile the Project (TypeScript compilation successful)
- [x] ✅ Create and Run Task (VS Code task created for running encoder)
- [x] ✅ Launch the Project (Application runs, connects to services, improved error handling)
- [x] ✅ Ensure Documentation is Complete (README.md created with full setup instructions)

### API Compatibility Requirements:
- Gateway: https://encoder-gateway.infra.3speak.tv
- Authentication: DID + JWS signatures
- Node registration, job polling, progress reporting
- Same configuration format as existing encoder