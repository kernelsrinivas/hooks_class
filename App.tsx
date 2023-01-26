import "react-native-gesture-handler";
import React from "react";
import { StatusBar, View, DeviceEventEmitter, EmitterSubscription, LogBox, Text, TextInput, AppState, InteractionManager } from "react-native";
import { AppNavigation } from "./src/routes/index";
import { GenericType } from "./src/common/utils/types/Generic";
import configureStore from "./src/common/store/index";
import rootSaga from "./src/common/store/saga/root_saga";
import { Provider } from "react-redux";
import AppStore from "./src/common/utils/appStore";
import SwitchPin from "./src/parentalPin/ParentalPin.index";
import { ThemeProvider } from "./src/theme/index";
import { THEME_CONTEXT_EMIT } from "./src/theme/theme.constants";
import { themeStyle } from "./src/theme/theme.styles";
import { ThemeStateType } from "./src/theme/theme.types";
import { getThemeFromType, setNativeAppInfo, getNativeConfigFromProps, getStatusBarHeight, getNativeAppInfo } from "./src/common/Helper";
import { INTERNET_OFFLINE_STATUS, PROFILE_TYPES, SESSION_EXPIRY } from "./src/utils/constants";
import SQLite, { ResultSet, SQLiteDatabase } from "react-native-sqlite-storage";
import { getDBObject, executeTransaction } from "./src/common/utils/SQLiteHelper";
import { Axis360NativeModule, EventEmitter, EVENTS } from "./src/common/utils/nativeModules";
import { ALERT_DB_CONST, DEVICE_EMITTER_EVENTS, DOWNLOAD_EMITTER_EVENTS, NETWORK_EMITTER_EVENTS } from "./src/common/utils/Constants";
import { getLibrarySettings, updateLoaderReducerAction } from "./src/common/action/CommonAction.index";
import { LoginInfo } from "./src/common/utils/types/Types";
import { getNotificationCountAction } from "./src/notification/action";
import { INITIAL_SAGA_WATCHER } from "./src/common/store/constants/ActionTypes";
import { updateAlertNotification } from "./src/notification/action/index";
import { InternetOffline, networkStatusCheck, updateInternetStatus, updateOnlineLoadShimmer } from "./src/common/widgets/InternetOffline";
import NetInfo from "@react-native-community/netinfo";
import { TRANSKEYS } from "./src/translations/keymap";
import { PersistGate } from "redux-persist/integration/react";
import { persistStore } from "redux-persist";
import { getThirdPartySagaAction, THIRD_PARTY } from "./src/thirdParty/actions/ThirdParty.action";
import CodePush from "react-native-code-push";
import { resetProgramShimmerEffect } from "./src/programs/action/ProgramActions";
import { DownloadProcess } from "./src/thirdParty/components/DownloadProcess";
import Alert from "./src/common/widgets/Alert";
import { translate } from "./src/translations/i18n";
import { updateThirdPartyDownloadReducerAction } from "./src/thirdParty/actions/ThirdPartyDownload.action";
import crashlytics from "@react-native-firebase/crashlytics";
import { NATIVE_DOWNLOAD_FAIL_EVENT } from "./src/myStuff/constants/Constants";
import { networkType } from "./src/common/utils/network";

LogBox.ignoreLogs(["[react-native-gesture-handler] Seems like you're using an old API with gesture components, check out new Gestures system!"]);
LogBox.ignoreLogs(["Warning: ..."]); // Ignore log notification by message
LogBox.ignoreAllLogs(); //Ignore all log notifications

const store = configureStore({});
const persistor = persistStore(store);
crashlytics().setCrashlyticsCollectionEnabled(true);
store.runSaga(rootSaga);
AppStore.getStore().setDispatch(store.dispatch);

interface State {
    connStatus?: string;
    appState?: string;
    theme: ThemeStateType;
    isNetworkConnected: boolean;
    title: string;
    message: string;
    showSessionExpiryAlert: boolean;
}
interface AppProps extends LoginInfo {
    props: GenericType;
    profiletype: string;
    initialRouteName: string;
}
const STATUS_BAR_HEIGHT = getStatusBarHeight();

/* font scaling disabled */
if (Text.defaultProps == null) {
    Text.defaultProps = {};
    Text.defaultProps.allowFontScaling = false;
}
if (TextInput.defaultProps == null) {
    TextInput.defaultProps = {};
    TextInput.defaultProps.allowFontScaling = false;
}
const options = {
    checkFrequency: CodePush.CheckFrequency.MANUAL,
};

class App extends React.Component<AppProps, State> {
    emitInstance: EmitterSubscription;
    netInstance: EmitterSubscription;
    apiInstance: EmitterSubscription;
    internetInstance: EmitterSubscription;
    successInstance: EmitterSubscription;
    failureInstance: EmitterSubscription;
    progressInstance: EmitterSubscription;
    sessionExpiry: EmitterSubscription;
    promiseManager: { cancel: () => void } | undefined;
    constructor(props: AppProps | Readonly<AppProps>) {
        super(props);
        this.state = {
            theme: themeStyle[this.props.profiletype ? getThemeFromType(props) : PROFILE_TYPES.CHILD],
            isNetworkConnected: true,
            title: "",
            message: "",
            showSessionExpiryAlert: false,
        };
        setNativeAppInfo(getNativeConfigFromProps(this.props));
        store.dispatch({ type: INITIAL_SAGA_WATCHER });
        this.emitInstance = {} as EmitterSubscription;
        this.netInstance = {} as EmitterSubscription;
        this.apiInstance = {} as EmitterSubscription;
        this.internetInstance = {} as EmitterSubscription;
        this.successInstance = {} as EmitterSubscription;
        this.failureInstance = {} as EmitterSubscription;
        this.progressInstance = {} as EmitterSubscription;
        this.sessionExpiry = {} as EmitterSubscription;
        this.promiseManager = undefined;
    }
    onSuccessFetchResult = (result: ResultSet): void => {
        store.dispatch(updateAlertNotification({ notificationCount: result.rows.item(0).unreadNotification }));
    };
    fetchUpdatedNotification = (): void => {
        getDBObject({ name: ALERT_DB_CONST.DB_NAME }).then((dbObject: SQLiteDatabase) => {
            executeTransaction(dbObject, ALERT_DB_CONST.SELECT_QUERY, this.onSuccessFetchResult, []);
        });
    };
    onReceivePushNotification = (): void => {
        this.fetchUpdatedNotification();
    };

    codePushStatusDidChange(syncStatus: any): void {
        switch (syncStatus) {
            case CodePush.SyncStatus.CHECKING_FOR_UPDATE:
                break;
            case CodePush.SyncStatus.DOWNLOADING_PACKAGE:
                break;
            case CodePush.SyncStatus.AWAITING_USER_ACTION:
                break;
            case CodePush.SyncStatus.INSTALLING_UPDATE:
                break;
            case CodePush.SyncStatus.UP_TO_DATE:
            case CodePush.SyncStatus.UPDATE_INSTALLED:
                CodePush.notifyAppReady();
                break;
            case CodePush.SyncStatus.UPDATE_IGNORED:
                break;
            case CodePush.SyncStatus.UNKNOWN_ERROR:
                break;
        }
    }
    componentDidMount(): void {
        crashlytics().log("App primary componentDidMount called");
        AppState.addEventListener("change", this._handleAppStateChange);

        this.emitInstance = DeviceEventEmitter.addListener(THEME_CONTEXT_EMIT, this.changeTheme);
        NetInfo.addEventListener((info) => {
            const { isNetworkConnected } = this.state;
            if (isNetworkConnected && info.isConnected && info.isInternetReachable) {
                DeviceEventEmitter.emit("RETRY");
            }
            const netStatus = !!(info.isConnected || info.isInternetReachable);
            Axis360NativeModule && Axis360NativeModule.networkStateChanged && Axis360NativeModule.networkStateChanged(netStatus);
            !netStatus && store.dispatch(updateLoaderReducerAction({ isShelfLoading: false, isLibraryLoading: false }));
            !netStatus && store.dispatch(resetProgramShimmerEffect());
            this.changeNetworkStatus(netStatus, TRANSKEYS.NO_NET_WORK_TITLE, TRANSKEYS.NO_NET_WORK_MESSAGES);
            updateOnlineLoadShimmer(netStatus);
            networkStatusCheck(netStatus);
        });
        this.netInstance = DeviceEventEmitter.addListener(INTERNET_OFFLINE_STATUS, (status: { isNetworkConnected: boolean }): void => {
            // Internet on/off for bottom navigation
            this.changeNetworkStatus(status.isNetworkConnected, TRANSKEYS.NO_NET_WORK_TITLE, TRANSKEYS.NO_NET_WORK_MESSAGES);
        });
        this.internetInstance = DeviceEventEmitter.addListener(NETWORK_EMITTER_EVENTS.INTERNET_STATUS, (status: { isNetworkConnected: boolean }): void => {
            // Internet on/off for API
            this.changeNetworkStatus(status.isNetworkConnected, TRANSKEYS.NO_NET_WORK_TITLE, TRANSKEYS.NO_NET_WORK_MESSAGES);
        });
        this.apiInstance = DeviceEventEmitter.addListener(DEVICE_EMITTER_EVENTS.API_TIMEOUT_STATUS, (status: { data: boolean; isNetworkConnected: boolean }): void => {
            // API timeout
            this.changeNetworkStatus(!status.data || status.isNetworkConnected, TRANSKEYS.MODAL_ERROR_MESSAGE_TITLE, TRANSKEYS.AN_ERROR_OCCURED);
        });
        this.successInstance = DeviceEventEmitter.addListener(DOWNLOAD_EMITTER_EVENTS.DOWNLOAD_SUCCESS_STATUS, (status): void => {
            store.dispatch(getThirdPartySagaAction({ action: THIRD_PARTY.DOWNLOAD, data: { ...status, getDownloadedData: true } }));
        });
        this.failureInstance = DeviceEventEmitter.addListener(DOWNLOAD_EMITTER_EVENTS.DOWNLOAD_FAILURE_STATUS, (status): void => {
            const downloadStatus = {
                title: "",
                percentage: 0,
                visibility: false,
                error: status.message || "",
                errorCode: status?.code || "",
            };
            store.dispatch(updateThirdPartyDownloadReducerAction({ downloadStatus }));
        });
        this.progressInstance = DeviceEventEmitter.addListener(DOWNLOAD_EMITTER_EVENTS.DOWNLOAD_PROGRESS_STATUS, (state): void => {
            const downloadStatus = {
                title: state.title,
                percentage: state.progress,
                visibility: state.progress >= 100 ? false : true,
                error: "",
            };
            store.dispatch(updateThirdPartyDownloadReducerAction({ downloadStatus }));
        });
        this.sessionExpiry = DeviceEventEmitter.addListener(SESSION_EXPIRY, this.sessionExpiryAlert);
        SQLite.enablePromise(true);
        this.fetchUpdatedNotification();
        EventEmitter.addListener(EVENTS.MESSAGE_RECEIVED, this.onReceivePushNotification);
        EventEmitter.addListener("KZEventEmitterMiniPlayerAction", (data = {}) => {
            store.dispatch({ type: "UPDATE_PLAY_TIME", payload: { ...data, time: data.time }, meta: data.isVisible });
        });
        this.promiseManager = InteractionManager.runAfterInteractions(() => {
            store.dispatch(getLibrarySettings());
            store.dispatch(getNotificationCountAction());
        });
    }
    sessionExpiryAlert = (): void => {
        this.setState({ showSessionExpiryAlert: true });
    };
    changeTheme = (type = PROFILE_TYPES.ADULT): void => {
        this.setState({ theme: themeStyle[type] });
    };

    resetMyShelfNoAlert = (status: boolean): void => {
        const nativeInfo = getNativeAppInfo();
        nativeInfo["hideNoNetAlert"] = status;
        setNativeAppInfo(nativeInfo);
    };
    changeNetworkStatus = async (status: boolean, title: string, message: string): Promise<void> => {
        EventEmitter.emit(NATIVE_DOWNLOAD_FAIL_EVENT, { networkChange: status, netType: await networkType() });
        updateInternetStatus(status);
        const flag = getNativeAppInfo().isMyStuffDownload || getNativeAppInfo().hideNoNetAlert || (getNativeAppInfo().isAppLaunch && !status);
        this.setState({ isNetworkConnected: flag ? true : status, title, message });
        this.resetMyShelfNoAlert(false);
    };

    componentWillUnmount(): void {
        this.emitInstance.remove();
        this.netInstance.remove();
        this.apiInstance.remove();
        this.internetInstance.remove();
        this.successInstance.remove();
        this.failureInstance.remove();
        this.progressInstance.remove();
        this.sessionExpiry.remove();
        AppState.removeEventListener("change", this._handleAppStateChange);
        this.promiseManager && this.promiseManager.cancel();
    }

    _handleAppStateChange = (nextAppState: any): void => {
        if (nextAppState === "active") {
            CodePush.sync({ installMode: CodePush.InstallMode.IMMEDIATE, updateDialog: false }, this.codePushStatusDidChange.bind(this));
        }
    };

    render(): JSX.Element {
        const { isNetworkConnected, title, message, showSessionExpiryAlert } = this.state;
        return (
            <Provider store={store}>
                <PersistGate persistor={persistor}>
                    <ThemeProvider value={this.state.theme}>
                        <View style={{ flex: 1 }}>
                            <View style={{ height: STATUS_BAR_HEIGHT, backgroundColor: "#06275C" }}>
                                <StatusBar translucent backgroundColor="#06275C" barStyle="light-content" />
                            </View>
                            <AppNavigation initialRouteName={this.props.initialRouteName} />
                            <SwitchPin />
                            <DownloadProcess />
                        </View>
                        <InternetOffline isConnected={isNetworkConnected} title={title} message={message} />
                        <Alert
                            title={translate(TRANSKEYS.SESSION_EXPIRED)}
                            subTitle={translate(TRANSKEYS.SESSION_EXPIRED_MESSAGE)}
                            isVisible={showSessionExpiryAlert}
                            buttons={[
                                {
                                    name: translate(TRANSKEYS.OK_BUTTON),
                                    onPress: (): void => {
                                        this.setState({ showSessionExpiryAlert: false });
                                        Axis360NativeModule && Axis360NativeModule.doLogin && Axis360NativeModule.doLogin();
                                    },
                                },
                            ]}
                        />
                    </ThemeProvider>
                </PersistGate>
            </Provider>
        );
    }
}

export default CodePush(options)(App);
