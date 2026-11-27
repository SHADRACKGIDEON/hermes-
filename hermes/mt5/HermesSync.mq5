//+------------------------------------------------------------------+
//| HermesSync - sends every closed MT5 position to your Hermes      |
//| journal. Attach to any one chart of the account being journaled. |
//+------------------------------------------------------------------+
#property copyright "Hermes"
#property version   "1.00"
input string ServerURL   = "https://your-hermes-server.com/api/ea/trades";
input string JournalKey  = "";   // from Hermes > Connect MT5
input int    BackfillDays = 30;  // history sent on start

string Esc(string s){StringReplace(s,"\\","\\\\");StringReplace(s,"\"","\\\"");return s;}

bool Post(string body)
{
   char data[],result[]; string rh;
   int n=StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8)-1;
   ArrayResize(data,n);
   string h="Content-Type: application/json\r\nX-Hermes-Key: "+JournalKey+"\r\n";
   int code=WebRequest("POST",ServerURL,h,30000,data,result,rh);
   if(code<0){Print("Hermes: request failed (error ",GetLastError(),"). Add the server URL under Tools > Options > Expert Advisors.");return false;}
   if(code!=200){Print("Hermes: server replied ",code," ",CharArrayToString(result));return false;}
   return true;
}

// Builds one JSON trade for a fully closed position; "" if still open or not found.
string TradeJson(ulong pos)
{
   for(int i=0;i<PositionsTotal();i++){ulong tk=PositionGetTicket(i);if(tk>0&&(ulong)PositionGetInteger(POSITION_IDENTIFIER)==pos)return "";}
   if(!HistorySelectByPosition(pos))return "";
   double pnl=0,vol=0,po=0,pc=0; datetime to=0,tc=0; string sym="",side="buy"; bool out=false;
   for(int i=0;i<HistoryDealsTotal();i++)
   {
      ulong d=HistoryDealGetTicket(i);
      long ty=HistoryDealGetInteger(d,DEAL_TYPE), en=HistoryDealGetInteger(d,DEAL_ENTRY);
      if(ty!=DEAL_TYPE_BUY && ty!=DEAL_TYPE_SELL) continue;
      pnl+=HistoryDealGetDouble(d,DEAL_PROFIT)+HistoryDealGetDouble(d,DEAL_COMMISSION)+HistoryDealGetDouble(d,DEAL_SWAP)+HistoryDealGetDouble(d,DEAL_FEE);
      sym=HistoryDealGetString(d,DEAL_SYMBOL);
      if(en==DEAL_ENTRY_IN)
      {
         if(to==0){to=(datetime)HistoryDealGetInteger(d,DEAL_TIME);po=HistoryDealGetDouble(d,DEAL_PRICE);side=(ty==DEAL_TYPE_BUY)?"buy":"sell";}
         vol+=HistoryDealGetDouble(d,DEAL_VOLUME);
      }
      else {out=true;tc=(datetime)HistoryDealGetInteger(d,DEAL_TIME);pc=HistoryDealGetDouble(d,DEAL_PRICE);}
   }
   if(!out||sym=="")return "";
   int dg=(int)SymbolInfoInteger(sym,SYMBOL_DIGITS);
   return StringFormat("{\"ticket\":\"%I64u\",\"symbol\":\"%s\",\"side\":\"%s\",\"vol\":%.2f,\"po\":\"%s\",\"pc\":\"%s\",\"opened\":\"%s\",\"closed\":\"%s\",\"pnl\":%.2f}",
      pos,Esc(sym),side,vol,DoubleToString(po,dg),DoubleToString(pc,dg),
      TimeToString(to,TIME_DATE|TIME_SECONDS),TimeToString(tc,TIME_DATE|TIME_SECONDS),pnl);
}

bool SendBatch(string trades)
{
   string acc=IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   return Post("{\"account\":\""+acc+"\",\"trades\":["+trades+"]}");
}

void Backfill(int days)
{
   if(!HistorySelect(TimeCurrent()-(datetime)days*86400,TimeCurrent()+86400))return;
   ulong ids[]; int n=HistoryDealsTotal();
   for(int i=0;i<n;i++)
   {
      ulong d=HistoryDealGetTicket(i);
      long ty=HistoryDealGetInteger(d,DEAL_TYPE), en=HistoryDealGetInteger(d,DEAL_ENTRY);
      if((ty!=DEAL_TYPE_BUY&&ty!=DEAL_TYPE_SELL)||en==DEAL_ENTRY_IN)continue;
      ulong p=(ulong)HistoryDealGetInteger(d,DEAL_POSITION_ID); bool f=false;
      for(int k=0;k<ArraySize(ids);k++)if(ids[k]==p){f=true;break;}
      if(!f){int s=ArraySize(ids);ArrayResize(ids,s+1);ids[s]=p;}
   }
   string batch=""; int c=0;
   for(int k=0;k<ArraySize(ids);k++)
   {
      string j=TradeJson(ids[k]); if(j=="")continue;
      batch+=(c>0?",":"")+j; c++;
      if(c>=50){SendBatch(batch);batch="";c=0;}
   }
   if(c>0)SendBatch(batch);
}

int OnInit()
{
   if(JournalKey==""){Print("Hermes: paste your Journal Key into the inputs.");return INIT_PARAMETERS_INCORRECT;}
   EventSetTimer(300);
   Backfill(BackfillDays);
   Print("Hermes: sync running for account ",AccountInfoInteger(ACCOUNT_LOGIN));
   return INIT_SUCCEEDED;
}
void OnDeinit(const int reason){EventKillTimer();}
void OnTimer(){Backfill(1);}   // retry safety net
void OnTradeTransaction(const MqlTradeTransaction &t,const MqlTradeRequest &rq,const MqlTradeResult &rs)
{
   if(t.type!=TRADE_TRANSACTION_DEAL_ADD||!HistoryDealSelect(t.deal))return;
   if(HistoryDealGetInteger(t.deal,DEAL_ENTRY)==DEAL_ENTRY_IN)return;
   string j=TradeJson((ulong)HistoryDealGetInteger(t.deal,DEAL_POSITION_ID));
   if(j!="")SendBatch(j);
}
void OnTick(){}
