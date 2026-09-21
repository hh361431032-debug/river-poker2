export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export function json(data:any,status=200){
  return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json",...corsHeaders}});
}
