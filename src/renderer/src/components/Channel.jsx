import ClientIndicator from './ClientIndicator'

function Channel({ channel, clients }) {
  return (
    <div>
      <div className="channel-item">{channel.name}</div>
      {clients.map((c) => (
        <ClientIndicator key={c.id} client={c} />
      ))}
    </div>
  )
}

export default Channel
