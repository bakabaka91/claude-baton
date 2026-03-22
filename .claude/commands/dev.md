Start the MCP server in development mode for manual testing:

1. Run `npm run build` first to ensure latest code is compiled
2. Start the server: `node dist/index.js`
3. The server uses stdio transport — it reads JSON-RPC from stdin and writes to stdout
4. To test a tool, pipe an MCP request:
   ```
   echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/index.js
   ```
5. Report the server status and available tools
