import { fail } from 'assert';
import * as React from 'react';
import useWebSocket from 'react-use-websocket';
import { DeepReadonly } from 'ts-essentials';

import { assertIsDefined, assertNever, reloadOutdatedPage, websocketUrl } from '../common';
import { useServerTime } from '../hooks';
import { version as codiesVersion } from '../metadata.json';
import { ClientNote, PartialClientNote, ServerNote, State, StatePlayer, WordPack } from '../protocol';
import { GameView, Sender } from './gameView';
import { Loading } from './loading';

const socketUrl = websocketUrl('/api/ws');

function useSender(dispatch: (action: PartialClientNote) => void): Sender {
    return React.useMemo<Sender>(() => {
        return {
            reveal: (row: number, col: number) =>
                dispatch({
                    method: 'reveal',
                    params: {
                        row,
                        col,
                    },
                }),
            newGame: () => dispatch({ method: 'newGame', params: {} }),
            endTurn: () => dispatch({ method: 'endTurn', params: {} }),
            changeNickname: (nickname: string) => dispatch({ method: 'changeNickname', params: { nickname } }),
            changeRole: (spymaster: boolean) => dispatch({ method: 'changeRole', params: { spymaster } }),
            changeTeam: (team: number) => dispatch({ method: 'changeTeam', params: { team } }),
            randomizeTeams: () => dispatch({ method: 'randomizeTeams', params: {} }),
            changePack: (num: number, enable: boolean) => dispatch({ method: 'changePack', params: { num, enable } }),
            changeTurnMode: (timed: boolean) => dispatch({ method: 'changeTurnMode', params: { timed } }),
            changeTurnTime: (seconds: number) => dispatch({ method: 'changeTurnTime', params: { seconds } }),
            addPacks: (packs: WordPack[]) => dispatch({ method: 'addPacks', params: { packs } }),
            removePack: (num: number) => dispatch({ method: 'removePack', params: { num } }),
            changeHideBomb: (hideBomb: boolean) => dispatch({ method: 'changeHideBomb', params: { hideBomb } }),
        };
    }, [dispatch]);
}

function usePlayer(state?: State): { pState: StatePlayer; pTeam: number } | undefined {
    return React.useMemo(() => {
        if (!state) {
            return undefined;
        }

        for (let i = 0; i < state.roomState.teams.length; i++) {
            const pState = state.roomState.teams[i].find((p) => p.playerID === state.playerID);
            if (pState) {
                return { pState, pTeam: i };
            }
        }

        fail('Player not found in any team');
    }, [state]);
}

const reconnectAttempts = 2;

function useWS(roomID: string, nickname: string, dead: () => void, onOpen: () => void) {
    const didUnmount = React.useRef(false);
    const retry = React.useRef(0);

    return useWebSocket(socketUrl, {
        // The names here matter; explicitly naming them so that renaming
        // these variables doesn't change the actual wire names.
        //
        // X-CODIES-VERSION would be cleaner, but the WS hook doesn't
        // support anything but query params.
        queryParams: { roomID: roomID, nickname: nickname, codiesVersion: codiesVersion },
        reconnectAttempts,
        onMessage: () => {
            retry.current = 0;
        },
        onOpen,
        onClose: (e: CloseEvent) => {
            if (e.code === 4418) {
                reloadOutdatedPage();
            }
        },
        shouldReconnect: () => {
            if (didUnmount.current) {
                return false;
            }

            retry.current++;

            if (retry.current >= reconnectAttempts) {
                dead();
                return false;
            }

            return true;
        },
    });
}

type StateAction = { method: 'setState'; state: State } | PartialClientNote;

function useStateReducer(sendNote: (r: ClientNote) => void) {
    // TODO: Create a new state which contains the server state.
    // TODO: Put sendNote in the state instead of reffing it?
    const sendNoteRef = React.useRef(sendNote);
    sendNoteRef.current = sendNote;

    return React.useCallback(
        (state: State | undefined, action: StateAction): State | undefined => {
            if (state === undefined) {
                if (action.method === 'setState') {
                    return action.state;
                }
                return state;
            }

            switch (action.method) {
                case 'setState':
                    return action.state;
                default:
                    sendNoteRef.current({ ...action, version: state.roomState.version });
                    return state;
            }
        },
        [sendNoteRef]
    );
}

export interface GameProps {
    roomID: string;
    nickname: string;
    leave: () => void;
}

export const Game = (props: DeepReadonly<GameProps>) => {
    const nickname = React.useRef(props.nickname); // Preserve a nickname for use in reconnects.

    const { syncTime } = useServerTime();
    const { sendJsonMessage, lastJsonMessage } = useWS(props.roomID, nickname.current, props.leave, syncTime);

    const reducer = useStateReducer(sendJsonMessage);
    const [state, dispatch] = React.useReducer(reducer, undefined);
    const player = usePlayer(state);
    const send = useSender(dispatch);

    React.useEffect(() => {
        if (!lastJsonMessage) {
            return;
        }

        const note = ServerNote.parse(lastJsonMessage);

        switch (note.method) {
            case 'state':
                dispatch({ method: 'setState', state: note.params });
                break;
            default:
                assertNever(note.method);
        }
    }, [lastJsonMessage]);

    if (!state) {
        return <Loading />;
    }

    assertIsDefined(player);
    nickname.current = player.pState.nickname;

    return (
        <GameView
            roomID={props.roomID}
            leave={props.leave}
            send={send}
            state={state.roomState}
            pState={player.pState}
            pTeam={player.pTeam}
        />
    );
};
