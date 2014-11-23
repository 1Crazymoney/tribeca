/// <reference path="utils.ts" />

class ExchangeBroker implements IBroker {
    _log : Logger;

    PositionUpdate = new Evt<ExchangeCurrencyPosition>();
    private _currencies : { [currency : number] : ExchangeCurrencyPosition } = {};
    public getPosition(currency : Currency) : ExchangeCurrencyPosition {
        return this._currencies[currency];
    }

    private onPositionUpdate = (rpt : CurrencyPosition) => {
        if (typeof this._currencies[rpt.currency] === "undefined" || this._currencies[rpt.currency].amount != rpt.amount) {
            var newRpt = rpt.toExchangeReport(this.exchange());
            this._currencies[rpt.currency] = newRpt;
            this.PositionUpdate.trigger(newRpt);
            this._log("New currency report: %o", newRpt);
        }
    };

    cancelOpenOrders() : void {
        for (var k in this._allOrders) {
            if (!this._allOrders.hasOwnProperty(k)) continue;
            var e : OrderStatusReport = this._allOrders[k].last();

            switch (e.orderStatus) {
                case OrderStatus.New:
                case OrderStatus.Working:
                    this.cancelOrder(new OrderCancel(e.orderId, e.exchange, date()));
                    break;
            }
        }
    }

    allOrderStates() : Array<OrderStatusReport> {
        var os : Array<OrderStatusReport> = [];
        for (var k in this._allOrders) {
            var e = this._allOrders[k];
            for (var i = 0; i < e.length; i++) {
                os.push(e[i]);
            }
        }
        return os;
    }

    OrderUpdate : Evt<OrderStatusReport> = new Evt<OrderStatusReport>();
    _allOrders : { [orderId: string]: OrderStatusReport[] } = {};
    _exchIdsToClientIds : { [exchId: string] : string} = {};

    private static generateOrderId = () => {
        // use moment.js?
        return new Date().getTime().toString(32)
    };

    sendOrder = (order : SubmitNewOrder) : SentOrder => {
        var orderId = ExchangeBroker.generateOrderId();
        var exch = this.exchange();
        var brokeredOrder = new BrokeredOrder(orderId, order.side, order.quantity, order.type, order.price, order.timeInForce, exch);

        var sent = this._oeGateway.sendOrder(brokeredOrder);

        var rpt : OrderStatusReport = {
            orderId: orderId,
            side: order.side,
            quantity: order.quantity,
            type: order.type,
            time: sent.sentTime,
            price: order.price,
            timeInForce: order.timeInForce,
            orderStatus: OrderStatus.New,
            exchange: exch,
            computationalLatency: sent.sentTime.diff(order.generatedTime)};
        this._allOrders[rpt.orderId] = [rpt];
        this.onOrderUpdate(rpt);

        return new SentOrder(rpt.orderId);
    };

    replaceOrder = (replace : CancelReplaceOrder) : SentOrder => {
        var rpt = this._allOrders[replace.origOrderId].last();
        var br = new BrokeredReplace(replace.origOrderId, replace.origOrderId, rpt.side,
            replace.quantity, rpt.type, replace.price, rpt.timeInForce, rpt.exchange, rpt.exchangeId);

        var sent = this._oeGateway.replaceOrder(br);

        var rpt : OrderStatusReport = {
            orderId: replace.origOrderId,
            orderStatus: OrderStatus.Working,
            pendingReplace: true,
            price: replace.price,
            quantity: replace.quantity,
            time: sent.sentTime,
            computationalLatency: sent.sentTime.diff(replace.generatedTime)};
        this.onOrderUpdate(rpt);

        return new SentOrder(rpt.orderId);
    };

    cancelOrder = (cancel : OrderCancel) => {
        var rpt = this._allOrders[cancel.origOrderId].last();
        var cxl = new BrokeredCancel(cancel.origOrderId, ExchangeBroker.generateOrderId(), rpt.side, rpt.exchangeId);
        var sent = this._oeGateway.cancelOrder(cxl);

        var rpt : OrderStatusReport = {
            orderId: cancel.origOrderId,
            orderStatus: OrderStatus.Working,
            pendingCancel: true,
            time: sent.sentTime,
            computationalLatency: sent.sentTime.diff(cancel.generatedTime)};
        this.onOrderUpdate(rpt);
    };

    public onOrderUpdate = (osr : OrderStatusReport) => {
        var orderChain = this._allOrders[osr.orderId];

        if (typeof orderChain === "undefined") {
            // this step and _exchIdsToClientIds is really BS, the exchanges should get their act together
            var secondChance = this._exchIdsToClientIds[osr.exchangeId];
            if (typeof secondChance !== "undefined") {
                osr.orderId = secondChance;
                orderChain = this._allOrders[secondChance];
            }
        }

        if (typeof orderChain === "undefined") {
            var keys = [];
            for (var k in this._allOrders)
                if (this._allOrders.hasOwnProperty(k))
                    keys.push(k);
            this._log("ERROR: cannot find orderId from %o, existing: %o", osr, keys);
        }

        var orig : OrderStatusReport = orderChain.last();

        var cumQuantity = osr.cumQuantity || orig.cumQuantity;
        var quantity = osr.quantity || orig.quantity;
        var partiallyFilled = cumQuantity > 0 && cumQuantity !== quantity;

        var o = new OrderStatusReportImpl(
            osr.side || orig.side,
            quantity,
            osr.type || orig.type,
            osr.price || orig.price,
            osr.timeInForce || orig.timeInForce,
            osr.orderId || orig.orderId,
            osr.exchangeId || orig.exchangeId,
            osr.orderStatus || orig.orderStatus,
            osr.rejectMessage,
            osr.time || date(),
            osr.lastQuantity,
            osr.lastPrice,
            osr.leavesQuantity || orig.leavesQuantity,
            cumQuantity,
            osr.averagePrice || orig.averagePrice,
            osr.liquidity,
            osr.exchange || orig.exchange,
            osr.computationalLatency,
            (typeof orig.version === "undefined") ? 0 : orig.version + 1,
            partiallyFilled,
            osr.pendingCancel,
            osr.pendingReplace,
            osr.cancelRejected
        );

        this._exchIdsToClientIds[osr.exchangeId] = osr.orderId;
        this._allOrders[osr.orderId].push(o);
        this._log("applied gw update -> %o", o);

        this.OrderUpdate.trigger(o);
    };

    makeFee() : number {
        return this._baseGateway.makeFee();
    }

    takeFee() : number {
        return this._baseGateway.takeFee();
    }


    name() : string {
        return this._baseGateway.name();
    }

    exchange() : Exchange {
        return this._baseGateway.exchange();
    }

    MarketData = new Evt<Market>();
    _currentBook : Market = null;

    public get currentBook() : Market {
        return this._currentBook;
    }

    private static getMarketDataFlag(current : MarketUpdate, previous : Market) {
        if (previous === null) return MarketDataFlag.First;

        var cmb = (c : MarketSide, p : MarketSide) => {
            var priceChanged = Math.abs(c.price - p.price) > 1e-4;
            var sizeChanged = Math.abs(c.size - p.size) > 1e-4;
            if (priceChanged && sizeChanged) return MarketDataFlag.PriceAndSizeChanged;
            if (priceChanged) return MarketDataFlag.PriceChanged;
            if (sizeChanged) return MarketDataFlag.SizeChanged;
            return MarketDataFlag.NoChange;
        };

        return (cmb(current.ask, previous.update.ask) | cmb(current.bid, previous.update.bid));
    }

    private handleMarketData = (book : MarketUpdate) => {
        if (this.currentBook == null || !book.equals(this.currentBook.update)) {
            this._currentBook = new Market(book, this.exchange(), ExchangeBroker.getMarketDataFlag(book, this.currentBook));
            this.MarketData.trigger(this.currentBook);
            this._log(this.currentBook);
        }
    };

    ConnectChanged = new Evt<ConnectivityStatus>();
    private mdConnected = ConnectivityStatus.Disconnected;
    private oeConnected = ConnectivityStatus.Disconnected;
    private _connectStatus = ConnectivityStatus.Disconnected;
    public onConnect = (gwType : GatewayType, cs : ConnectivityStatus) => {
        if (gwType == GatewayType.MarketData) this.mdConnected = cs;
        if (gwType == GatewayType.OrderEntry) this.oeConnected = cs;

        var newStatus = this.mdConnected == ConnectivityStatus.Connected && this.oeConnected == ConnectivityStatus.Connected
            ? ConnectivityStatus.Connected
            : ConnectivityStatus.Disconnected;

        if (newStatus != this._connectStatus)
            this.ConnectChanged.trigger(newStatus);
        else
            return;

        this._connectStatus = newStatus;
        this._log(GatewayType[gwType], "Connection status changed ", ConnectivityStatus[cs]);
    };

    public get connectStatus() : ConnectivityStatus {
        return this._connectStatus;
    }

    constructor(private _mdGateway : IMarketDataGateway,
                private _baseGateway : IExchangeDetailsGateway,
                private _oeGateway : IOrderEntryGateway,
                private _posGateway : IPositionGateway) {
        this._log = log("tribeca:exchangebroker:" + this._baseGateway.name());

        this._mdGateway.MarketData.on(this.handleMarketData);
        this._mdGateway.ConnectChanged.on(s => {
            if (s == ConnectivityStatus.Disconnected) this._currentBook = null;
            this.onConnect(GatewayType.MarketData, s);
        });

        this._oeGateway.OrderUpdate.on(this.onOrderUpdate);
        this._oeGateway.ConnectChanged.on(s => {
            this.onConnect(GatewayType.OrderEntry, s)
        });

        this._posGateway.PositionUpdate.on(this.onPositionUpdate);
    }
}